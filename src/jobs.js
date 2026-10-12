// Cola de trabajos en Postgres (pg-boss). Cada paso del flujo es un trabajo independiente:
// así se pueden procesar cientos de episodios a la vez, con reintentos y límites de concurrencia,
// y se puede escalar agregando más "workers" en Render.
//
// Reglas para que nada se quede pegado:
// - Cada trabajo "reclama" su registro con un UPDATE condicional antes de gastar (no hay cobros dobles).
// - Si un trabajo vence, el worker muere o un envío a la cola falla, el "vigilante" (cada 5 min)
//   encuentra el registro sin trabajo vivo y lo repara o lo marca con error para reintentar.
import { PgBoss } from "pg-boss";
import fs from "node:fs/promises";
import { config } from "./config.js";
import { q, one, all, tx } from "./db.js";
import * as repo from "./repo.js";
import * as storage from "./storage.js";
import * as nb from "./ai/nanobanana.js";
import * as ia from "./ai/claude.js";
import * as imagen from "./ai/imagen.js";
import { tipoImagen, miniatura, paraClaude, aclarar } from "./imagenes.js";
import * as video from "./video.js";
import { transcribir, transcripcionDisponible, guionConHablantes } from "./transcribir.js";
import * as caras from "./caras.js";
import * as biblioteca from "./biblioteca.js";
import { notificar } from "./notificar.js";
import { als, senal } from "./contexto.js";

export const boss = new PgBoss({
  connectionString: config.databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: 5,
});
boss.on("error", (e) => console.error("Cola:", e.message));

export const PRIORIDAD = { interactiva: 10, lote: 0 };

// expireInSeconds siempre mayor que el peor caso del trabajo (si vence, el vigilante lo repara).
const COLAS = {
  limpieza: { retryLimit: 1, expireInSeconds: 1800 },
  vigilante: { retryLimit: 0, expireInSeconds: 600 },
  ingesta: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 5400 },
  propuestas: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 2400 },
  imagen: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 900 },
  revisar: { retryLimit: 5, retryDelay: 15, retryBackoff: true, expireInSeconds: 300 },
  evaluar: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 1500 },
  rehacer: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 2400 },
  paquete: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 1500 },
};

export async function iniciarCola() {
  await boss.start();
  for (const [nombre, opts] of Object.entries(COLAS)) {
    const o = { ...opts, deleteAfterSeconds: 3 * 86400 };
    await boss.createQueue(nombre, o);
    await boss.updateQueue(nombre, o); // aplica cambios de configuración a colas ya creadas
  }
}

// Aviso de Nano Banana: la imagen ya está → se revisa de inmediato en vez de esperar el siguiente turno.
export async function avisoNanoBanana(taskId) {
  if (typeof taskId !== "string" || !taskId || taskId.length > 100) return;
  const p = await one(`SELECT id FROM propuestas WHERE imagen->>'taskId' = $1 AND imagen->>'estado' = 'generando' AND NOT archivada`, [taskId]);
  if (p) await enviar("revisar", { propuestaId: p.id, taskId, prioridad: PRIORIDAD.interactiva }, { prioridad: PRIORIDAD.interactiva });
}

export function enviar(nombre, data, { prioridad = PRIORIDAD.interactiva, startAfter } = {}) {
  return boss.send(nombre, data, { priority: prioridad, ...(startAfter ? { startAfter } : {}) });
}

const msg = (e, porDefecto) => (e?.publico ? e.message : porDefecto);
const publico = (m, extra = {}) => Object.assign(new Error(m), { publico: true, ...extra });
const normal = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// Envoltura: decide si un error se reintenta o se marca como fallido de una vez.
// La señal del trabajo viaja en el contexto: si pg-boss lo da por vencido, se cancelan sus llamadas.
function trabajo(nombre, fn, alFallar, concurrencia) {
  return boss.work(nombre, { localConcurrency: concurrencia, includeMetadata: true, pollingIntervalSeconds: 2 }, async ([job]) => {
    try {
      await als.run({ signal: job.signal }, () => fn(job.data, job));
    } catch (e) {
      if (job.signal?.aborted) throw e; // venció: pg-boss decide y el vigilante repara
      const quedan = job.retryCount < job.retryLimit;
      const reintentable = e?.reintentable ?? !e?.publico;
      if (reintentable && quedan) {
        console.warn(`[${nombre}] reintento ${job.retryCount + 1}: ${e.message}`);
        throw e;
      }
      console.error(`[${nombre}] falló:`, e.message);
      await alFallar(job.data, e).catch((e2) => console.error(e2));
    }
  });
}

// ---------- 1. Propuestas (Claude) ----------
async function hPropuestas({ episodioId, usuario, prioridad }) {
  const r0 = await q(`UPDATE episodios SET estado = 'pensando', error = NULL, actualizado = now()
                      WHERE id = $1 AND estado IN ('en_cola', 'pensando') RETURNING id`, [episodioId]);
  if (!r0.rowCount) return;
  let ep = await repo.episodio(episodioId);
  const canal = await repo.canal(ep.canal);

  // Modo masivo: si solo hay sinopsis, Claude completa el resto y arma o completa el cast.
  const castIncompleto = !ep.cast.length || ep.cast.some((c) => !c.rol);
  if (!ep.brief.giro || !ep.brief.momento || castIncompleto) {
    const r = await ia.completarBrief(ep, canal);
    await repo.sumarUso(usuario, "textos");
    const brief = { ...ep.brief };
    for (const k of ["giro", "momento", "desenlace", "escenario"]) if (!brief[k]) brief[k] = r[k];
    let cast;
    if (!ep.cast.length) {
      cast = r.personajes.slice(0, 4).map((p) => ({ ...p, actorId: null, actorNombre: null, tieneFotos: false }));
    } else {
      // Respeta el reparto de la hoja (y sus actores) y completa edad, rol y vestuario.
      cast = ep.cast.map((c) => {
        const p = r.personajes.find((x) => normal(x.personaje) === normal(c.personaje) || normal(x.personaje).includes(normal(c.personaje)));
        return { ...c, edad: c.edad || p?.edad || "", rol: c.rol || p?.rol || "otro", vestuario: c.vestuario || p?.vestuario || "" };
      });
    }
    await q("UPDATE episodios SET brief = $2, \"cast\" = $3 WHERE id = $1", [episodioId, brief, JSON.stringify(cast)]);
    ep = await repo.episodio(episodioId);
  }

  const r = await ia.generarPropuestas(ep, canal, await repo.feedbackReciente(ep.canal));
  await repo.sumarUso(usuario, "textos");
  if (!r.propuestas?.length) throw publico("Claude no devolvió propuestas.", { reintentable: true });
  const nuevas = await tx(async (c) => {
    const { rowCount } = await c.query("SELECT 1 FROM episodios WHERE id = $1 AND estado = 'pensando' FOR UPDATE", [episodioId]);
    if (!rowCount) return [];
    await c.query("UPDATE propuestas SET archivada = true WHERE episodio_id = $1 AND NOT archivada", [episodioId]);
    const ids = [];
    for (const [i, p] of r.propuestas.slice(0, 3).entries()) {
      const { rows } = await c.query("INSERT INTO propuestas (episodio_id, slot, data) VALUES ($1, $2, $3) RETURNING id", [episodioId, i, p]);
      ids.push(rows[0].id);
    }
    await c.query(`UPDATE episodios SET gancho = $2, estado = 'listo', elegida = NULL, paquete = NULL, eligiendo = false, actualizado = now() WHERE id = $1`, [episodioId, r.gancho]);
    return ids;
  });
  for (const id of nuevas) await enviar("imagen", { propuestaId: id, usuario, prioridad }, { prioridad });
}

// ---------- 2. Imagen (Nano Banana con respaldo) ----------
// Referencias: cuadros del propio video (flujo automático) o fotos de la biblioteca de actores,
// más un cuadro del lugar del momento cumbre si existe.
async function referencias(ep, data, { conEscena = true } = {}) {
  const enPortada = (ep.cast || []).filter((c) => (data.personajes_en_portada || []).some((n) => ia.mismoPersonaje(n, c.personaje)));
  const escena = conEscena ? (ep.brief.cuadros_momento || []).slice(0, 1) : [];
  // Reparte el cupo de referencias del modelo (Pro: 8, NB2: 14) entre los personajes de la portada.
  const cupo = (nb.MODELOS[ep.modelo]?.maxRefs || 8) - escena.length;
  const porPersonaje = Math.max(1, Math.min(4, Math.floor(cupo / Math.max(1, enPortada.length))));
  const refs = [];
  for (const c of enPortada) {
    const delEpisodio = c.fotos || [];
    let deBiblioteca = c.actorId ? await biblioteca.referencias(c.actorId, 3) : [];
    // Pocas caras en la biblioteca (p. ej. una sola foto subida): se completa con las fotos originales,
    // que además muestran peinado y vestuario.
    if (c.actorId && delEpisodio.length + deBiblioteca.length < porPersonaje) {
      const originales = (await one("SELECT fotos FROM actores WHERE id = $1", [c.actorId]))?.fotos || [];
      deBiblioteca = [...deBiblioteca, ...originales].slice(0, 3);
    }
    // Intercala: cara del episodio, cara de la biblioteca, medio cuerpo, otro ángulo…
    const orden = [delEpisodio[0], deBiblioteca[0], delEpisodio[1], deBiblioteca[1], delEpisodio[2], deBiblioteca[2]];
    const fotos = [...new Set(orden.filter(Boolean))].slice(0, porPersonaje);
    if (fotos.length) refs.push({ personaje: c.personaje, fotos });
  }
  if (escena.length) refs.push({ escena: true, fotos: escena });
  return refs;
}

// Sin foto, Nano Banana tiende a copiar la cara del actor de referencia en los demás personajes (dos "Yosuanis").
function unaCara(refs, personajes) {
  const conCara = refs.filter((r) => !r.escena).map((r) => r.personaje);
  const sinCara = personajes.filter((p) => !conCara.some((c) => ia.mismoPersonaje(c, p)));
  return `Each reference face is used for exactly one person: the character it belongs to (${conCara.join(", ")}). Nobody else in the image may share those faces.` +
    (sinCara.length ? ` ${sinCara.join(", ")} ${sinCara.length > 1 ? "are different people" : "is a different person"}: clearly different face, hair color and hairstyle, age and build.` : "") +
    " Background extras must also look clearly different from the reference actors.";
}

function promptConReferencias(prompt, refs, extra, personajes = []) {
  let n = 0;
  const mapa = refs.map((r) => {
    const idx = r.fotos.map(() => ++n);
    const s = idx.length > 1 ? "s" : "";
    return r.escena
      ? `Reference image${s} ${idx.join(", ")}: a frame of the real episode. Match its location, lighting and production design (not its composition).`
      : `Reference image${s} ${idx.join(", ")}: the real actor who plays ${r.personaje} (face close-ups and a half-body shot for wardrobe).`;
  });
  const cabeza = refs.length ? `${mapa.join("\n")}
LIKENESS IS THE TOP PRIORITY: each character must be instantly recognizable as the real actor in the references.
Copy the exact facial structure: eye shape and spacing, eyebrows, nose, lips, jawline, hairline, skin tone, wrinkles and age.
Do not beautify, slim, de-age or change ethnicity. Photorealistic skin, no plastic or airbrushed look.
Use the references ONLY for identity and wardrobe; build a new, more dramatic composition.
${unaCara(refs, personajes)}\n\n` : "";
  // Las portadas de la competencia son claras y saturadas: una portada oscura se pierde en la página de inicio.
  const luz = "LIGHTING: bright, high-key commercial lighting with vivid saturated colors; faces brightly and evenly lit. Even night or hospital scenes must read clearly at thumbnail size: no dark, gloomy or low-key images.";
  return `${cabeza}${prompt}\n\n${luz}${extra ? `\n\nFIX THESE PROBLEMS FROM THE PREVIOUS ATTEMPT: ${extra}` : ""}`;
}

// Prepara cada referencia como URL pública (Nano Banana) y como base64 (Google / Seedream).
async function prepararRefs(refs) {
  const salida = [];
  for (const r of refs) for (const key of r.fotos) {
    const base64 = (await paraClaude(await storage.leer(key))).toString("base64");
    salida.push({ base64, mime: "image/jpeg", url: config.refsPublicas ? await storage.urlPublica(key) : null });
  }
  return salida;
}

async function hImagen({ propuestaId, usuario, extra, prioridad, evitar = [], cobrar }) {
  // Reclamo atómico: solo un trabajo puede pasar de "en_cola" a "generando" (evita pagar dos veces).
  // "inicio" funciona como ficha: si mientras tanto alguien rehace o restaura, nuestras escrituras ya no aplican.
  const inicio = Date.now();
  const p = await one(`UPDATE propuestas SET imagen = imagen || jsonb_build_object('estado','generando','inicio',$2::bigint,'taskId',null,'error',null,'usuario',$3::text)
      WHERE id = $1 AND NOT archivada AND imagen->>'estado' = 'en_cola' RETURNING *`, [propuestaId, inicio, usuario]);
  if (!p) return;
  const MIO = `id = $1 AND imagen->>'estado' = 'generando' AND (imagen->>'inicio')::bigint = ${inicio}`;
  let pagada = false;
  try {
    const ep = await repo.episodio(p.episodio_id);
    const refs = await referencias(ep, p.data);
    // Qué actores van con foto y quién no (se muestra en la tarjeta y en los registros).
    const conFoto = refs.filter((r) => !r.escena).map((r) => ({ personaje: r.personaje, n: r.fotos.length }));
    const sinFoto = (p.data.personajes_en_portada || []).filter((n) => !conFoto.some((c) => ia.mismoPersonaje(c.personaje, n)));
    console.log(`[imagen] ${propuestaId.slice(0, 8)} con foto: ${conFoto.map((c) => `${c.personaje}(${c.n})`).join(", ") || "nadie"} · sin foto: ${sinFoto.join(", ") || "nadie"}`);
    const prompt = promptConReferencias(p.data.prompt_imagen, refs, extra, p.data.personajes_en_portada || []);
    const r = await imagen.generar({
      prompt, refs: await prepararRefs(refs), modelo: ep.modelo, evitar,
      alCambiar: (prov, err) => avisarCambio(ep.canal, prov, err),
    });
    pagada = true;
    const intentos = (p.imagen.intentos || 0) + 1;
    const taskId = r.taskId || `${r.proveedor}_${inicio}`;
    const { rowCount } = await q(`UPDATE propuestas SET imagen = imagen || $2::jsonb WHERE ${MIO}`, [propuestaId,
      { taskId, proveedor: r.proveedor, intentos, conReferencias: refs.length > 0, conFoto, sinFoto, evitar }]);
    if (cobrar) await repo.sumarUso(usuario, "imagenes").catch(() => {});
    if (!rowCount) return; // la propuesta cambió mientras se pintaba: se descarta este resultado
    if (r.taskId) {
      await repo.tocarEpisodio(p.episodio_id);
      await enviar("revisar", { propuestaId, taskId, prioridad, evitar }, { prioridad, startAfter: taskId.startsWith("mock_") ? 2 : 10 });
    } else {
      await guardarResultado(propuestaId, taskId, r.buffer, prioridad);
    }
  } catch (e) {
    if (!pagada) {
      // Devuelve el reclamo para que el reintento (o el vigilante) pueda tomarlo.
      await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"en_cola"}'::jsonb WHERE ${MIO}`, [propuestaId]);
      throw e;
    }
    // La imagen ya se pagó pero no se pudo guardar: no reintentar (evita pagar sin fin mientras falla el almacenamiento).
    console.error("[imagen] pagada pero no guardada:", e.message);
    throw publico("La imagen se generó pero no se pudo guardar. Revisa el almacenamiento y dale reintentar.");
  }
}

async function fallaImagen({ propuestaId }, e) {
  // Si falló un repintado automático, se conserva la portada anterior: sigue siendo válida.
  const conservada = await one(`UPDATE propuestas SET imagen = (imagen - 'autoReintento') || jsonb_build_object('estado','lista','error',null,'taskId',null,'repintadoFallido',$2::text)
      WHERE id = $1 AND imagen->>'estado' <> 'lista' AND imagen ? 'autoReintento' AND imagen ? 'key' AND NOT archivada RETURNING imagen->>'key' AS key`,
    [propuestaId, msg(e, "No se pudo repintar.")]);
  if (conservada) {
    // Quita la copia que se guardó en versiones antes de repintar (es la misma imagen).
    await q(`DELETE FROM versiones WHERE id = (SELECT id FROM versiones WHERE propuesta_id = $1 AND imagen->>'key' = $2 ORDER BY creado DESC LIMIT 1)`, [propuestaId, conservada.key]);
    const p = await repo.propuesta(propuestaId);
    if (p) { await repo.tocarEpisodio(p.episodio_id); await quizaAutoElegir(p.episodio_id); }
    return;
  }
  await q(`UPDATE propuestas SET imagen = imagen || $2::jsonb WHERE id = $1 AND imagen->>'estado' <> 'lista'`,
    [propuestaId, { estado: "error", error: msg(e, "No se pudo crear la imagen.") }]);
  const p = await repo.propuesta(propuestaId);
  if (p) { await repo.tocarEpisodio(p.episodio_id); await quizaAutoElegir(p.episodio_id); }
}

// Avisa (máx. 1 vez cada 30 min) cuando se usa un proveedor de respaldo.
let ultimoAviso = 0;
async function avisarCambio(canalId, proveedor, error) {
  if (Date.now() - ultimoAviso < 30 * 60e3) return;
  ultimoAviso = Date.now();
  const nombre = imagen.PROVEEDORES[proveedor]?.nombre || proveedor;
  await notificar({ webhook_url: process.env.NOTIFY_WEBHOOK_URL || (await repo.canal(canalId))?.webhook_url },
    `⚠️ El proveedor de imágenes principal falló (${String(error || "").slice(0, 120)}). Gancho está usando ${nombre} de respaldo.`);
}

// Si Nano Banana falla o tarda demasiado, se pasa la imagen al siguiente proveedor.
async function aRespaldo({ propuestaId, taskId, prioridad, evitar = [] }, motivo = "Nano Banana no pudo crear la imagen.") {
  const quedan = imagen.orden().filter((x) => ![...evitar, "nanobanana"].includes(x));
  if (!quedan.length) return fallaImagen({ propuestaId }, publico(motivo));
  const r = await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"en_cola","taskId":null}'::jsonb
    WHERE id = $1 AND imagen->>'estado' = 'generando' AND imagen->>'taskId' = $2`, [propuestaId, taskId]);
  if (!r.rowCount) return;
  const p = await repo.propuesta(propuestaId); if (!p) return; // se borró (episodio eliminado o archivado)
  imagen.registrarFalla("nanobanana");
  await enviar("imagen", { propuestaId, usuario: p.imagen.usuario, prioridad, evitar: [...evitar, "nanobanana"], cobrar: true }, { prioridad });
}

// ---------- 3. Revisar si la imagen de Nano Banana ya está ----------
async function descargar(url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("URL de imagen no segura");
  const res = await fetch(u, { signal: senal(60000) });
  if (!res.ok) throw new Error(`Descarga falló: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error("Imagen demasiado grande");
  return buf;
}

async function guardarResultado(propuestaId, taskId, buf, prioridad) {
  let ext = tipoImagen(buf);
  if (!ext) throw new Error("El archivo recibido no es una imagen");
  // Si salió oscura, se aclara para que no se pierda junto a las portadas de otros canales.
  const luz = await aclarar(buf).catch(() => null);
  if (luz?.cambio) { buf = luz.buf; ext = "jpg"; }
  const key = await storage.guardar("portadas", buf, ext);
  const mini = await storage.guardar("mini", await miniatura(buf), "jpg");
  const { rowCount } = await q(`UPDATE propuestas SET imagen = imagen || $3::jsonb WHERE id = $1 AND imagen->>'taskId' = $2 AND imagen->>'estado' = 'generando' AND NOT archivada`,
    [propuestaId, taskId, { estado: "lista", key, mini, error: null, luz: luz ? { antes: luz.antes, despues: luz.despues } : null }]);
  if (!rowCount) { await storage.borrar(key); await storage.borrar(mini); return; }
  const p = await repo.propuesta(propuestaId); if (!p) return; // se borró (episodio eliminado o archivado)
  await repo.tocarEpisodio(p.episodio_id);
  await enviar("evaluar", { propuestaId, key, prioridad }, { prioridad });
}

const PLAZO_NB = 12 * 60e3;
async function hRevisar(data) {
  const { propuestaId, taskId, prioridad } = data;
  const p = await repo.propuesta(propuestaId);
  if (!p || p.archivada || p.imagen.taskId !== taskId || p.imagen.estado !== "generando") return;
  const vencido = Date.now() - p.imagen.inicio > PLAZO_NB;
  let r;
  try {
    r = await nb.consultarTarea(taskId);
  } catch (e) {
    // Caída temporal de Nano Banana: la tarea puede seguir viva (ya pagada). Volver a preguntar luego.
    if (e.reintentable && !vencido) return enviar("revisar", data, { prioridad, startAfter: 30 });
    if (vencido) return aRespaldo(data, "Nano Banana no respondió a tiempo.");
    throw e;
  }
  if (r.estado === "generando") {
    if (vencido) return aRespaldo(data, "Nano Banana tardó demasiado.");
    return enviar("revisar", data, { prioridad, startAfter: 5 });
  }
  if (r.estado === "error") return aRespaldo(data, r.error);
  const buf = r.buffer || (await descargar(r.url));
  try { await guardarResultado(propuestaId, taskId, buf, prioridad); }
  catch (e) { e.almacenamiento = true; throw e; } // la imagen existe: no se debe pagar otra en un respaldo
}

// ---------- 4. Evaluar la portada (Claude con visión) ----------
async function hEvaluar({ propuestaId, key, prioridad, sinReintento }) {
  const r0 = await q(`UPDATE propuestas SET evaluando = true WHERE id = $1 AND NOT archivada AND imagen->>'key' = $2 AND imagen->>'estado' = 'lista' RETURNING id`, [propuestaId, key]);
  if (!r0.rowCount) return;
  let ev;
  try {
    const p = await repo.propuesta(propuestaId);
    if (!p) return;
    const ep = await repo.episodio(p.episodio_id);
    const b64 = async (k) => ({ base64: (await paraClaude(await storage.leer(k))).toString("base64"), mime: "image/jpeg" });
    const refs = await Promise.all((await referencias(ep, p.data, { conEscena: false })).map(async (r) => ({ personaje: r.personaje, ...(await b64(r.fotos[0])) })));
    ev = await ia.evaluarPortada({ imagen: await b64(key), propuesta: p.data, referencias: refs });
    // Parecido objetivo: compara las caras de la portada con la huella de cada actor (episodio o biblioteca).
    const objetivos = [];
    for (const c of ep.cast || []) {
      if (!(p.data.personajes_en_portada || []).some((n) => ia.mismoPersonaje(n, c.personaje))) continue;
      const h = c.huella || (c.actorId ? await biblioteca.huellaDe(c.actorId) : null);
      if (h) objetivos.push({ personaje: c.personaje, huella: h });
    }
    if (objetivos.length) {
      const enPortada = await caras.analizarCuadro(await storage.leer(key), { minArea: 0.002, minScore: 0.6, maxGiro: 0.75, minNitidez: 2 }).catch(() => []); // piel de IA = poca "nitidez"
      ev.parecido = objetivos.map((o) => ({
        personaje: o.personaje,
        sim: Math.round(Math.max(0, ...enPortada.map((c) => caras.similitud(o.huella, c.huella))) * 100) / 100,
      }));
      const bajos = ev.parecido.filter((x) => x.sim < 0.35);
      // La misma cara del actor en dos o más personas = personaje duplicado.
      const repetidos = objetivos.filter((o) => enPortada.filter((c) => caras.similitud(o.huella, c.huella) >= 0.45).length >= 2).map((o) => o.personaje);
      if (repetidos.length) ev.duplicados = repetidos;
      if (bajos.length || repetidos.length) {
        ev.aprobada = false;
        ev.problemas = [...repetidos.map((n) => `La cara de ${n} aparece repetida en otro personaje`),
          ...bajos.map((x) => `La cara de ${x.personaje} no se parece al actor real`), ...(ev.problemas || [])].slice(0, 3);
      }
    }
  } finally {
    if (!ev) await q("UPDATE propuestas SET evaluando = false WHERE id = $1", [propuestaId]);
  }
  const p = await repo.propuesta(propuestaId); if (!p) return; // se borró (episodio eliminado o archivado)
  const ep = await one("SELECT elegida, eligiendo FROM episodios WHERE id = $1", [p.episodio_id]);
  // No se repinta sola si el usuario solo cambió el título, ni si ya está elegida o se está eligiendo.
  const reintentar = !ev.aprobada && (p.imagen.intentos || 1) < 2 && !sinReintento && ep.elegida !== propuestaId && !ep.eligiendo
    && (await alcanzaParaRepintar());
  const fila = await one(`UPDATE propuestas SET evaluacion = $3, evaluando = false,
      imagen = CASE WHEN $4 THEN imagen || jsonb_build_object('autoReintento', $5::jsonb, 'estado', 'en_cola') ELSE imagen END
    WHERE id = $1 AND imagen->>'key' = $2 AND imagen->>'estado' = 'lista' RETURNING id`, [propuestaId, key, ev, reintentar, JSON.stringify(ev.problemas)]);
  if (!fila) await q("UPDATE propuestas SET evaluando = false WHERE id = $1", [propuestaId]);
  await repo.tocarEpisodio(p.episodio_id);
  if (!fila) return;
  if (reintentar) {
    const extra = [...ev.problemas, ...(ev.parecido?.some((x) => x.sim < 0.35) ? ["MATCH THE REFERENCE FACES EXACTLY: same facial structure, same age, same skin tone"] : []),
      ...(ev.duplicados?.length ? [`ONLY ONE PERSON may have the face of ${ev.duplicados.join(", ")}; every other person needs a clearly different face and hair`] : [])].join("; ");
    // La versión con defectos se guarda (se puede restaurar) en vez de perderse.
    await q("INSERT INTO versiones (propuesta_id, data, imagen, evaluacion, feedback) VALUES ($1,$2,$3,$4,$5)",
      [propuestaId, p.data, p.imagen, ev, { objetivo: "portada", razones: ["Revisión automática"], comentario: ev.problemas.join("; ") }]);
    return enviar("imagen", { propuestaId, usuario: p.imagen.usuario, extra, prioridad, cobrar: true }, { prioridad });
  }
  await quizaAutoElegir(p.episodio_id);
}

// Sin créditos suficientes no se repinta sola: una portada imperfecta vale más que un error de "sin créditos".
async function alcanzaParaRepintar() {
  if (config.mockImages || imagen.orden()[0] !== "nanobanana") return true;
  const c = await nb.creditos({ espera: 15000, fresco: true });
  return c !== null && c >= config.creditsPerImage; // si no se sabe el saldo, no se arriesga la portada
}

// Cuando las 3 propuestas terminaron (listas o con error):
// - lote con "elegir solo" → elige la mejor
// - flujo automático → la aprueba sola si pasa el umbral del canal; si no, avisa que hay una por aprobar
async function quizaAutoElegir(episodioId) {
  const ep = await one(`SELECT e.*, l.auto_elegir FROM episodios e LEFT JOIN lotes l ON l.id = e.lote_id WHERE e.id = $1`, [episodioId]);
  if (!ep || ep.elegida || ep.eligiendo || ep.estado !== "listo") return;
  const ps = await all("SELECT * FROM propuestas WHERE episodio_id = $1 AND NOT archivada", [episodioId]);
  if (!ps.length || ps.some((p) => ["en_cola", "generando"].includes(p.imagen.estado) || p.evaluando || p.rehaciendo)) return;
  const canal = await repo.canal(ep.canal);
  const listas = ps.filter((p) => p.imagen.estado === "lista");
  const avisarPorAprobar = async (texto) => {
    if (ep.origen !== "auto") return;
    const r = await q("UPDATE episodios SET aprobacion = 'por_aprobar', actualizado = now() WHERE id = $1 AND aprobacion IS DISTINCT FROM 'por_aprobar'", [episodioId]);
    if (r.rowCount) await notificar(canal, texto, `#/ep/${episodioId}`);
  };
  if (!listas.length) return avisarPorAprobar(`🔴 "${ep.titulo}": las 3 portadas fallaron. Entra a reintentar.`);
  const nota = (p) => p.evaluacion?.calificacion_final ?? p.data.calificacion?.total ?? 0;
  const mejor = listas.sort((a, b) => nota(b) - nota(a))[0];
  const aprobarSola = ep.auto_elegir || (ep.origen === "auto" && canal.auto_aprobar != null && nota(mejor) >= canal.auto_aprobar && mejor.evaluacion?.aprobada !== false);
  if (!aprobarSola) return avisarPorAprobar(`🟡 "${ep.titulo}" tiene portadas listas para aprobar (mejor: ${nota(mejor)}/100).`);
  const { rowCount } = await q("UPDATE episodios SET eligiendo = true, actualizado = now() WHERE id = $1 AND NOT eligiendo AND elegida IS NULL AND estado = 'listo'", [episodioId]);
  if (rowCount) await enviar("paquete", { episodioId, propuestaId: mejor.id, usuario: ep.creado_por, automatico: true }, { prioridad: PRIORIDAD.lote });
}

// ---------- 5. Rehacer con la razón del equipo ----------
async function hRehacer({ propuestaId, objetivo, razones, comentario, usuario, prioridad }) {
  const p = await repo.propuesta(propuestaId);
  if (!p || p.archivada || p.rehaciendo !== objetivo) return;
  const ep = await repo.episodio(p.episodio_id);
  const canal = await repo.canal(ep.canal);
  const nueva = await ia.rehacerPropuesta(ep, canal, p.data, { objetivo, razones, comentario }, await repo.feedbackReciente(ep.canal));
  await repo.sumarUso(usuario, "textos");
  const data = objetivo === "titulo"
    ? { ...p.data, titulo: nueva.titulo, traduccion: nueva.traduccion, formula: nueva.formula, porque_funciona: nueva.porque_funciona, riesgo: nueva.riesgo, calificacion: nueva.calificacion }
    : nueva;
  const hecho = await tx(async (c) => {
    const { rows: [actual] } = await c.query("SELECT * FROM propuestas WHERE id = $1 FOR UPDATE", [propuestaId]);
    if (!actual || actual.archivada || actual.rehaciendo !== objetivo) return false;
    await c.query("INSERT INTO versiones (propuesta_id, data, imagen, evaluacion, feedback) VALUES ($1,$2,$3,$4,$5)",
      [propuestaId, actual.data, actual.imagen, actual.evaluacion, { objetivo, razones, comentario }]);
    await c.query(`UPDATE propuestas SET data = $2, version = version + 1, evaluacion = NULL, evaluando = false, rehaciendo = NULL, error_rehacer = NULL, editado = false,
        imagen = CASE WHEN $3 THEN jsonb_build_object('estado','en_cola','intentos',0,'usuario',$4::text) ELSE imagen END WHERE id = $1`,
      [propuestaId, data, objetivo !== "titulo", usuario]);
    await c.query("UPDATE episodios SET elegida = NULL, paquete = NULL, aprobacion = NULL, actualizado = now() WHERE id = $1 AND elegida = $2", [ep.id, propuestaId]);
    await c.query("UPDATE episodios SET actualizado = now() WHERE id = $1", [ep.id]);
    return true;
  });
  if (!hecho) return;
  if (objetivo === "titulo") {
    if (p.imagen.key && p.imagen.estado === "lista") await enviar("evaluar", { propuestaId, key: p.imagen.key, prioridad, sinReintento: true }, { prioridad });
  } else await enviar("imagen", { propuestaId, usuario, prioridad }, { prioridad });
}

// ---------- 6. Paquete: descripción, tags, hashtags ----------
async function hPaquete({ episodioId, propuestaId, usuario, automatico }) {
  const ep = await repo.episodio(episodioId);
  const p = ep?.propuestas.find((x) => x.id === propuestaId);
  if (!ep?.eligiendo) return;
  if (!p || p.imagen.estado !== "lista" || p.rehaciendo) return q("UPDATE episodios SET eligiendo = false WHERE id = $1", [episodioId]);
  const paquete = await ia.generarPaquete(ep, await repo.canal(ep.canal), p.data);
  await repo.sumarUso(usuario, "textos");
  // Solo se guarda si la propuesta sigue vigente y lista (pudo cambiar mientras Claude escribía).
  const { rowCount } = await q(`UPDATE episodios SET elegida = $2, paquete = $3, eligiendo = false, error = NULL, actualizado = now(),
      aprobacion = CASE WHEN origen = 'auto' THEN $4 ELSE aprobacion END
    WHERE id = $1 AND eligiendo AND EXISTS (SELECT 1 FROM propuestas WHERE id = $2 AND NOT archivada AND rehaciendo IS NULL AND imagen->>'estado' = 'lista')`,
    [episodioId, propuestaId, paquete, automatico ? "auto" : "manual"]);
  if (!rowCount) return q("UPDATE episodios SET eligiendo = false WHERE id = $1", [episodioId]);
  const canal = await repo.canal(ep.canal);
  if (ep.origen === "auto") {
    await notificar(canal, automatico ? `🟢 "${ep.titulo}" se aprobó sola: "${p.data.titulo}"` : `✅ "${ep.titulo}" lista: "${p.data.titulo}"`, `#/ep/${episodioId}`);
  }
  if (ep.lote_id) {
    // Marca atómica: el aviso de lote listo sale una sola vez.
    const l = await one(`UPDATE lotes SET notificado = true WHERE id = $1 AND NOT notificado
        AND NOT EXISTS (SELECT 1 FROM episodios WHERE lote_id = $1 AND paquete IS NULL) RETURNING nombre,
        (SELECT count(*)::int FROM episodios WHERE lote_id = $1) AS total`, [ep.lote_id]);
    if (l) await notificar(canal, `📦 El lote "${l.nombre}" está listo: ${l.total} episodios con portada, título y descripción.`, `#/lote/${ep.lote_id}`);
  }
}

// ---------- 0. Ingesta: del video al brief (flujo automático) ----------
// 1) Transcribe máx. 40 min (inicio, mitad y final si es más largo) con quién habla y cuándo.
// 2) Revisa ≈5 min de video donde hablan los personajes principales y detecta caras (local, gratis).
// 3) Recorta cara y medio cuerpo de los mejores cuadros; Claude dice qué recorte es de qué personaje.
async function hIngesta({ episodioId, usuario }) {
  const ep = await repo.episodio(episodioId);
  if (!ep || ep.estado !== "procesando") return;
  if (!ep.video?.key) throw publico("El video original ya no existe (se borra a los 7 días). Súbelo de nuevo.");
  const canal = await repo.canal(ep.canal);
  const etapa = (e, extra = {}) => q(`UPDATE episodios SET video = video || $2::jsonb, actualizado = now() WHERE id = $1 AND estado = 'procesando'`, [episodioId, { etapa: e, ...extra }]);
  const dir = await video.carpetaTemporal();
  const nuevos = [];
  const guardar = async (buf) => { const k = await storage.guardar("cuadros", buf, "jpg"); nuevos.push(k); return k; };
  try {
    await etapa("leyendo");
    const entrada = await storage.entradaFfmpeg(ep.video.key);
    const total = await video.duracion(entrada);
    if (total < 20) throw publico("El video dura menos de 20 segundos.");
    const duracionMin = Math.round(total / 60);
    // Hack (varios episodios en un video): todo se saca solo del 1er episodio.
    let segundos = total;
    if (ep.video.hack) {
      const corte = ep.video.finPrimero ? { seg: Math.min(ep.video.finPrimero, total), metodo: "manual" }
        : await video.finPrimeraHistoria(entrada, total, ep.video.episodios || 3).catch(() => ({ seg: Math.round(total / (ep.video.episodios || 3)), metodo: "estimado" }));
      segundos = Math.max(60, corte.seg);
      await etapa("leyendo", { corte });
    }

    // Cuadros generales (para entender lugares y escenas).
    const generales = await video.extraerCuadros(entrada, segundos, dir, 24);
    if (generales.length < 6) throw publico("No pude sacar cuadros del video.");
    const keys = {};
    for (const c of generales) keys[c.n] = await guardar(await fs.readFile(c.archivo));
    await etapa("transcribiendo", { duracion: Math.round(total) });

    // Transcripción (subtítulos subidos > audio limitado a 40 min).
    let texto = ep.video.subtitulos ? video.textoDeSubtitulos(ep.video.subtitulos, ep.video.hack ? segundos : Infinity) : "";
    let fuente = texto ? "subtitulos" : "ninguna";
    let frases = [];
    let parcial = false;
    if (!texto && transcripcionDisponible()) {
      try {
        const tramos = video.planTranscripcion(segundos);
        parcial = tramos.length > 1;
        const r = await transcribir(await video.audioDeTramos(entrada, tramos, dir), canal.idioma);
        frases = r.frases.map((f) => ({ ...f, inicio: video.tiempoReal(f.inicio, tramos), fin: video.tiempoReal(f.fin, tramos) }));
        texto = frases.length ? guionConHablantes(frases) : r.texto;
        fuente = r.proveedor;
      } catch (e) { console.warn("Transcripción omitida:", e.message); texto = ""; fuente = "ninguna"; }
    }

    // Detector de caras en ≈5 min del video → caras agrupadas por persona → reconocidas contra la biblioteca de actores.
    await etapa("caras", { fuente, minutosTranscritos: Math.round(video.planTranscripcion(segundos).reduce((s, t) => s + t.dur, 0) / 60) });
    let personas = [];
    try {
      const todas = [];
      for (const [i, v] of video.planCaras(segundos, frases).entries()) {
        for (const c of await video.cuadrosDeVentana(entrada, v, dir, `v${i}`)) {
          for (const u of await caras.analizarCuadro(c.archivo).catch(() => [])) todas.push({ ...u, t: c.t, archivo: c.archivo, hablante: c.hablante });
        }
      }
      personas = caras.agrupar(todas).filter((g) => g.caras.length >= 2 || g.caras[0].calidad > 6).slice(0, 6);
      for (const [i, g] of personas.entries()) {
        g.n = i + 1;
        g.elegidas = caras.mejores(g, 3);
        for (const c of g.elegidas) Object.assign(c, await caras.recortes(c.archivo, c.cara));
        const votos = {};
        for (const c of g.caras) if (c.hablante && c.sola) votos[c.hablante] = (votos[c.hablante] || 0) + 1;
        const [h, nv] = Object.entries(votos).sort((a, b) => b[1] - a[1])[0] || [];
        g.hablante = nv >= 2 ? h : null;
        g.actor = await biblioteca.identificar(g.centro);
      }
    } catch (e) { console.warn("Detector de caras omitido:", e.message); personas = []; }

    await etapa("analizando");
    const r = await ia.analizarVideo({
      canal, transcripcion: texto, parcial, duracionMin, conHablantes: frases.some((f) => f.hablante),
      hojas: await video.hojasDeContacto(generales), hojasCaras: personas.length ? await video.hojaDePersonas(personas) : [],
      personas: personas.map((g) => ({ n: g.n, apariciones: g.caras.length, hablante: g.hablante, actor: g.actor?.nombre })),
      nombreArchivo: ep.video.nombre, notas: ep.brief.notas,
    });
    await repo.sumarUso(usuario, "textos");

    // Cada personaje: sus mejores caras del episodio (frente, 3/4, medio cuerpo) y su actor.
    // Si el comparador no conoce al actor, Gancho lo crea con el nombre del personaje para que el equipo lo renombre.
    const porNumero = Object.fromEntries(personas.map((g) => [g.n, g]));
    const cast = [];
    const usadas = new Set();
    for (const p of r.personajes.slice(0, 4)) {
      const g = porNumero[p.persona];
      let fotos = [], actor = null, huella = null;
      if (g && !usadas.has(g.n)) {
        usadas.add(g.n);
        const [a, b] = g.elegidas;
        fotos = [await guardar(a.rostro), await guardar(a.medio)];
        if (b) fotos.push(await guardar(b.rostro));
        huella = g.centro.map((x) => Math.round(x * 1e4) / 1e4);
        actor = g.actor || (["transgresor", "victima", "villano"].includes(p.rol) ? await biblioteca.crearActorAuto(`${p.personaje} (sin nombre)`, usuario) : null);
        if (actor) await biblioteca.agregarDeEpisodio(actor.actorId || actor.id, g.elegidas, episodioId);
      } else {
        fotos = p.cuadros.map((n) => keys[n]).filter(Boolean).slice(0, 2);
      }
      cast.push({ personaje: p.personaje, edad: p.edad, rol: p.rol, vestuario: p.vestuario, descripcion: p.descripcion_visual,
        hablante: p.hablante || g?.hablante || null, fotos, huella,
        actorId: actor ? (actor.actorId || actor.id) : null, actorNombre: actor?.nombre || null,
        reconocido: Boolean(g?.actor), tieneFotos: fotos.length > 0 });
    }
    const brief = { ...ep.brief, sinopsis: r.sinopsis, giro: r.giro, momento: r.momento, desenlace: r.desenlace, escenario: r.escenario,
      duracion_min: duracionMin, cuadros_momento: r.cuadros_momento.map((n) => keys[n]).filter(Boolean).slice(0, 2) };
    const viejos = [...(ep.video.cuadros || [])];
    const { rowCount } = await q(`UPDATE episodios SET titulo = CASE WHEN titulo = '' OR titulo LIKE 'Video:%' THEN $2 ELSE titulo END, brief = $3, "cast" = $4,
        video = video || $5::jsonb, estado = 'en_cola', actualizado = now() WHERE id = $1 AND estado = 'procesando'`,
      [episodioId, r.titulo_interno, brief, JSON.stringify(cast), {
        etapa: "listo", calidad: r.calidad, cuadros: [...nuevos], personasDetectadas: personas.length, transcripcion: texto.slice(0, 200000),
      }]);
    if (!rowCount) throw publico("El episodio cambió mientras se procesaba.");
    nuevos.length = 0; // ya pertenecen al episodio
    for (const v of viejos) await storage.borrar(v); // cuadros de un intento anterior
    await enviar("propuestas", { episodioId, usuario, prioridad: PRIORIDAD.lote }, { prioridad: PRIORIDAD.lote });
  } finally {
    for (const kk of nuevos) await storage.borrar(kk).catch(() => {}); // intento fallido: no dejar huérfanos
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------- Vigilante: repara lo que se quedó pegado ----------
// Un registro está "pegado" si lleva más de 10 min en un estado de espera y no existe ningún trabajo vivo para él.
const VIVO = (cola, campo, col) => `EXISTS (SELECT 1 FROM pgboss.job j WHERE j.name = '${cola}' AND j.state IN ('created','retry','active') AND j.data->>'${campo}' = ${col}::text)`;
async function hVigilante() {
  const n = {};
  const contar = (k, r) => (n[k] = (r.rowCount ?? r.length) || 0);
  contar("ingesta", await q(`UPDATE episodios e SET estado = 'error', error = 'El procesamiento se interrumpió. Dale reintentar.', video = video || '{"etapa":"error"}'::jsonb, actualizado = now()
    WHERE estado = 'procesando' AND actualizado < now() - interval '15 minutes' AND NOT ${VIVO("ingesta", "episodioId", "e.id")}`));
  contar("propuestas", await q(`UPDATE episodios e SET estado = 'error', error = 'Se interrumpió. Dale "Intentar de nuevo".', actualizado = now()
    WHERE estado IN ('en_cola','pensando') AND actualizado < now() - interval '10 minutes' AND NOT ${VIVO("propuestas", "episodioId", "e.id")}`));
  // Las reparaciones de abajo no cambian "actualizado" hasta el final, para no taparse entre ellas.
  const viejo = `(SELECT actualizado FROM episodios WHERE id = p.episodio_id) < now() - interval '10 minutes'`;
  const tocados = new Set();
  const paq = await all(`UPDATE episodios e SET eligiendo = false
    WHERE eligiendo AND actualizado < now() - interval '10 minutes' AND NOT ${VIVO("paquete", "episodioId", "e.id")} RETURNING id`);
  n.paquete = paq.length; paq.forEach((r) => tocados.add(r.id));
  const reh = await all(`UPDATE propuestas p SET rehaciendo = NULL, error_rehacer = 'Se interrumpió. Intenta de nuevo.'
    WHERE rehaciendo IS NOT NULL AND NOT archivada AND NOT ${VIVO("rehacer", "propuestaId", "p.id")} AND ${viejo} RETURNING episodio_id`);
  n.rehacer = reh.length; reh.forEach((r) => tocados.add(r.episodio_id));
  const evaluando = await all(`UPDATE propuestas p SET evaluando = false WHERE evaluando AND NOT ${VIVO("evaluar", "propuestaId", "p.id")}
      AND ${viejo} RETURNING episodio_id`);
  n.evaluar = evaluando.length; evaluando.forEach((r) => tocados.add(r.episodio_id));
  // Imágenes sin trabajo: se vuelven a encolar (el reclamo atómico evita duplicados).
  const imgs = await all(`SELECT p.id, p.episodio_id, p.imagen, e.creado_por FROM propuestas p JOIN episodios e ON e.id = p.episodio_id
    WHERE NOT p.archivada AND p.imagen->>'estado' IN ('en_cola','generando')
      AND coalesce((p.imagen->>'inicio')::bigint, 0) < $1 AND (e.actualizado < now() - interval '10 minutes' OR e.id = ANY($2))
      AND NOT ${VIVO("imagen", "propuestaId", "p.id")} AND NOT ${VIVO("revisar", "propuestaId", "p.id")}`, [Date.now() - 15 * 60e3, [...tocados]]);
  for (const p of imgs) {
    const reparaciones = (p.imagen.reparaciones || 0) + 1;
    const cond = `id = $1 AND imagen->>'estado' = $2 AND coalesce(imagen->>'inicio', '') = coalesce($3, '')`;
    const args = [p.id, p.imagen.estado, p.imagen.inicio == null ? null : String(p.imagen.inicio)];
    if (reparaciones > 2) {
      // Ya se intentó reparar dos veces: algo está mal (almacenamiento, proveedor). Se marca para revisión humana.
      await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"error","error":"Se atoró varias veces. Revisa el almacenamiento y dale reintentar."}'::jsonb WHERE ${cond}`, args);
      tocados.add(p.episodio_id);
      continue;
    }
    if (p.imagen.estado === "generando" && p.imagen.taskId && p.imagen.proveedor === "nanobanana") {
      const r = await q(`UPDATE propuestas SET imagen = imagen || jsonb_build_object('reparaciones', $4::int) WHERE ${cond}`, [...args, reparaciones]);
      if (r.rowCount) await enviar("revisar", { propuestaId: p.id, taskId: p.imagen.taskId, evitar: p.imagen.evitar || [] }, { prioridad: PRIORIDAD.lote });
    } else {
      const r = await q(`UPDATE propuestas SET imagen = imagen || jsonb_build_object('estado','en_cola','taskId',null,'reparaciones',$4::int) WHERE ${cond}`, [...args, reparaciones]);
      if (r.rowCount) await enviar("imagen", { propuestaId: p.id, usuario: p.imagen.usuario || p.creado_por, evitar: p.imagen.evitar || [] }, { prioridad: PRIORIDAD.lote });
    }
  }
  n.imagenes = imgs.length;
  if (tocados.size) await q("UPDATE episodios SET actualizado = now() WHERE id = ANY($1)", [[...tocados]]);
  for (const id of tocados) await quizaAutoElegir(id);
  if (Object.values(n).some(Boolean)) console.warn("Vigilante reparó:", n);
}

export async function iniciarWorkers() {
  const c = config.concurrency;
  await trabajo("ingesta", hIngesta, async ({ episodioId, usuario }, e) => {
    await q(`UPDATE episodios SET estado = 'error', error = $2, video = video || '{"etapa":"error"}'::jsonb, actualizado = now() WHERE id = $1`,
      [episodioId, msg(e, "No se pudo procesar el video.")]);
    const ep = await one("SELECT titulo, canal FROM episodios WHERE id = $1", [episodioId]);
    if (ep) await notificar(await repo.canal(ep.canal), `🔴 No se pudo procesar el video de "${ep.titulo}": ${msg(e, "error desconocido")}`, `#/ep/${episodioId}`);
    await repo.devolverCupo(usuario, 3);
  }, Number(process.env.VIDEO_CONCURRENCY || 2));
  await trabajo("propuestas", hPropuestas, async ({ episodioId, usuario }, e) => {
    await q("UPDATE episodios SET estado = 'error', error = $2, actualizado = now() WHERE id = $1", [episodioId, msg(e, "No se pudieron crear las propuestas.")]);
    await repo.devolverCupo(usuario, 3); // las 3 portadas reservadas nunca se pidieron
  }, c.claude);
  await trabajo("imagen", hImagen, fallaImagen, c.images);
  await trabajo("revisar", hRevisar, (d, e) => (e?.almacenamiento
    ? fallaImagen(d, publico("La imagen se generó pero no se pudo guardar. Revisa el almacenamiento y dale reintentar."))
    : aRespaldo(d, msg(e, "No se pudo descargar la imagen de Nano Banana."))), c.polling);
  await trabajo("evaluar", hEvaluar, async ({ propuestaId }) => {
    await q("UPDATE propuestas SET evaluando = false WHERE id = $1", [propuestaId]);
    const p = await repo.propuesta(propuestaId);
    if (p) await quizaAutoElegir(p.episodio_id);
  }, c.claude);
  await trabajo("rehacer", hRehacer, async ({ propuestaId, objetivo, usuario }, e) => {
    if (objetivo !== "titulo") await repo.devolverCupo(usuario, 1);
    await q("UPDATE propuestas SET rehaciendo = NULL, error_rehacer = $2 WHERE id = $1", [propuestaId, msg(e, "No se pudo rehacer. Intenta de nuevo.")]);
    const p = await repo.propuesta(propuestaId);
    if (p) await repo.tocarEpisodio(p.episodio_id);
  }, c.claude);
  await trabajo("paquete", hPaquete, async ({ episodioId }, e) =>
    q("UPDATE episodios SET eligiendo = false, error = $2, actualizado = now() WHERE id = $1", [episodioId, msg(e, "No se pudieron escribir la descripción y los tags.")]), c.claude);
  // Los videos originales pesan mucho: se borran tras VIDEO_RETENTION_DAYS (las portadas y cuadros se quedan).
  await trabajo("limpieza", async () => {
    const dias = Number(process.env.VIDEO_RETENTION_DAYS || 7);
    const viejos = await all(`SELECT id, video->>'key' AS key FROM episodios WHERE video->>'key' IS NOT NULL AND creado < now() - make_interval(days => $1) AND estado <> 'procesando' LIMIT 500`, [dias]);
    for (const v of viejos) {
      await storage.borrar(v.key);
      await q(`UPDATE episodios SET video = (video - 'key') || '{"borrado":true}'::jsonb WHERE id = $1`, [v.id]);
    }
    if (viejos.length) console.log(`Limpieza: ${viejos.length} videos originales borrados`);
  }, async () => {}, 1);
  await trabajo("vigilante", hVigilante, async () => {}, 1);
  biblioteca.ponerAlDia().catch((e) => console.warn("Biblioteca:", e.message));
  await boss.schedule("limpieza", "0 9 * * *"); // 3 a. m. hora de México
  await boss.schedule("vigilante", "*/5 * * * *");
  console.log(`Workers listos · Claude x${c.claude} · imágenes x${c.images} · proveedores: ${imagen.orden().join(" → ") || "ninguno"}`);
}

export async function estadoCola() {
  const out = {};
  for (const n of Object.keys(COLAS)) {
    try { const [s] = await boss.getQueueStats(n); out[n] = { pendientes: s?.queuedCount ?? 0, activos: s?.activeCount ?? 0 }; }
    catch { out[n] = null; }
  }
  return out;
}
