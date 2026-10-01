// Cola de trabajos en Postgres (pg-boss). Cada paso del flujo es un trabajo independiente:
// así se pueden procesar cientos de episodios a la vez, con reintentos y límites de concurrencia,
// y se puede escalar agregando más "workers" en Render.
import { PgBoss } from "pg-boss";
import { config } from "./config.js";
import { q, one, all, tx } from "./db.js";
import * as repo from "./repo.js";
import * as storage from "./storage.js";
import * as nb from "./ai/nanobanana.js";
import * as ia from "./ai/claude.js";
import { tipoImagen, miniatura, paraClaude } from "./imagenes.js";

export const boss = new PgBoss({
  connectionString: config.databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: 5,
});
boss.on("error", (e) => console.error("Cola:", e.message));

export const PRIORIDAD = { interactiva: 10, lote: 0 };

const COLAS = {
  propuestas: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  imagen: { retryLimit: 4, retryDelay: 20, retryBackoff: true, expireInSeconds: 120 },
  revisar: { retryLimit: 5, retryDelay: 10, expireInSeconds: 120 },
  evaluar: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
  rehacer: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 600 },
  paquete: { retryLimit: 3, retryDelay: 30, retryBackoff: true, expireInSeconds: 300 },
};

export async function iniciarCola() {
  await boss.start();
  for (const [nombre, opts] of Object.entries(COLAS)) await boss.createQueue(nombre, { ...opts, deleteAfterSeconds: 3 * 86400 });
}

export function enviar(nombre, data, { prioridad = PRIORIDAD.interactiva, startAfter } = {}) {
  return boss.send(nombre, data, { priority: prioridad, ...(startAfter ? { startAfter } : {}) });
}

const msg = (e, porDefecto) => (e?.publico ? e.message : porDefecto);

// Envoltura: decide si un error se reintenta o se marca como fallido de una vez.
function trabajo(nombre, fn, alFallar, concurrencia) {
  return boss.work(nombre, { localConcurrency: concurrencia, includeMetadata: true, pollingIntervalSeconds: 2 }, async ([job]) => {
    try {
      await fn(job.data, job);
    } catch (e) {
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
  let ep = await repo.episodio(episodioId);
  if (!ep) return;
  const canal = await repo.canal(ep.canal);
  await q("UPDATE episodios SET estado = 'pensando', error = NULL, actualizado = now() WHERE id = $1", [episodioId]);

  // Modo masivo: si solo hay sinopsis, Claude completa el resto y arma el cast.
  if (!ep.brief.giro || !ep.brief.momento || !ep.cast.length) {
    const r = await ia.completarBrief(ep, canal);
    await repo.sumarUso(usuario, "textos");
    const brief = { ...ep.brief };
    for (const k of ["giro", "momento", "desenlace", "escenario"]) if (!brief[k]) brief[k] = r[k];
    let cast = ep.cast;
    if (!cast.length) {
      const mapa = brief.actoresMapa || {};
      const actores = Object.keys(mapa).length ? await all("SELECT id, nombre, fotos FROM actores WHERE id = ANY($1)", [Object.values(mapa)]) : [];
      cast = r.personajes.slice(0, 4).map((p) => {
        const actorId = mapa[normal(p.personaje)];
        const actor = actores.find((a) => a.id === actorId);
        return { ...p, actorId: actor?.id || null, actorNombre: actor?.nombre || null, tieneFotos: Boolean(actor?.fotos?.length) };
      });
    }
    await q("UPDATE episodios SET brief = $2, \"cast\" = $3 WHERE id = $1", [episodioId, brief, JSON.stringify(cast)]);
    ep = await repo.episodio(episodioId);
  }

  const r = await ia.generarPropuestas(ep, canal, await repo.feedbackReciente(ep.canal));
  await repo.sumarUso(usuario, "textos");
  const nuevas = await tx(async (c) => {
    await c.query("UPDATE propuestas SET archivada = true WHERE episodio_id = $1 AND NOT archivada", [episodioId]);
    const ids = [];
    for (const [i, p] of r.propuestas.slice(0, 3).entries()) {
      const { rows } = await c.query("INSERT INTO propuestas (episodio_id, slot, data) VALUES ($1, $2, $3) RETURNING id", [episodioId, i, p]);
      ids.push(rows[0].id);
    }
    await c.query(`UPDATE episodios SET gancho = $2, estado = 'listo', elegida = NULL, paquete = NULL, actualizado = now() WHERE id = $1`, [episodioId, r.gancho]);
    return ids;
  });
  for (const id of nuevas) await enviar("imagen", { propuestaId: id, usuario, prioridad }, { prioridad });
}
const normal = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

// ---------- 2. Imagen (Nano Banana) ----------
async function referencias(ep, data, { urls }) {
  const nombres = (data.personajes_en_portada || []).map(normal);
  const refs = [];
  for (const c of ep.cast) {
    if (!c.actorId || !nombres.includes(normal(c.personaje))) continue;
    const actor = await one("SELECT fotos FROM actores WHERE id = $1", [c.actorId]);
    const fotos = (actor?.fotos || []).slice(0, 2);
    if (!fotos.length) continue;
    refs.push({ personaje: c.personaje, fotos, urls: urls ? await Promise.all(fotos.map(storage.urlPublica)) : [] });
  }
  return refs;
}

function promptConReferencias(prompt, refs, extra) {
  let n = 0;
  const mapa = refs.map((r) => {
    const idx = r.urls.map(() => ++n);
    return `Reference image${idx.length > 1 ? "s" : ""} ${idx.join(", ")}: the real actor who plays ${r.personaje}. Keep this exact face, skin tone, hair and age.`;
  });
  const cabeza = refs.length ? `${mapa.join("\n")}\nUse the reference images ONLY for the faces and identities of those characters. Do not copy their backgrounds or clothes.\n\n` : "";
  return `${cabeza}${prompt}${extra ? `\n\nFIX THESE PROBLEMS FROM THE PREVIOUS ATTEMPT: ${extra}` : ""}`;
}

async function hImagen({ propuestaId, usuario, extra, prioridad }) {
  const p = await repo.propuesta(propuestaId);
  if (!p || p.archivada) return;
  const ep = await repo.episodio(p.episodio_id);
  const refs = config.refsPublicas ? await referencias(ep, p.data, { urls: true }) : [];
  const taskId = await nb.crearTarea({ modelo: ep.modelo, prompt: promptConReferencias(p.data.prompt_imagen, refs, extra), imageUrls: refs.flatMap((r) => r.urls) });
  if (!config.mockImages) await repo.sumarUso(usuario, "imagenes");
  await q(`UPDATE propuestas SET imagen = imagen || $2::jsonb WHERE id = $1`, [propuestaId, {
    estado: "generando", taskId, inicio: Date.now(), intentos: (p.imagen.intentos || 0) + 1, usuario, conReferencias: refs.length > 0, error: null,
  }]);
  await repo.tocarEpisodio(p.episodio_id);
  await enviar("revisar", { propuestaId, taskId, prioridad }, { prioridad, startAfter: taskId.startsWith("mock_") ? 2 : 20 });
}

async function fallaImagen({ propuestaId }, e) {
  await q(`UPDATE propuestas SET imagen = imagen || $2::jsonb WHERE id = $1`, [propuestaId, { estado: "error", error: msg(e, "Nano Banana no pudo crear la imagen.") }]);
  const p = await repo.propuesta(propuestaId);
  if (p) await repo.tocarEpisodio(p.episodio_id);
}

// ---------- 3. Revisar si la imagen ya está ----------
async function descargar(url) {
  const u = new URL(url);
  if (u.protocol !== "https:") throw new Error("URL de imagen no segura");
  const res = await fetch(u, { signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Descarga falló: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 25 * 1024 * 1024) throw new Error("Imagen demasiado grande");
  const ext = tipoImagen(buf);
  if (!ext) throw new Error("El archivo descargado no es una imagen");
  return { buf, ext };
}

async function hRevisar({ propuestaId, taskId, prioridad }) {
  const p = await repo.propuesta(propuestaId);
  if (!p || p.archivada || p.imagen.taskId !== taskId || p.imagen.estado !== "generando") return;
  let r = await nb.consultarTarea(taskId);
  if (r.estado === "generando" && Date.now() - p.imagen.inicio > 10 * 60e3) r = { estado: "error", error: "Nano Banana tardó demasiado." };
  if (r.estado === "generando") return enviar("revisar", { propuestaId, taskId, prioridad }, { prioridad, startAfter: 8 });
  if (r.estado === "error") return fallaImagen({ propuestaId }, { publico: true, message: r.error });

  const { buf, ext } = r.buffer ? { buf: r.buffer, ext: "jpg" } : await descargar(r.url);
  const key = await storage.guardar("portadas", buf, ext);
  const mini = await storage.guardar("mini", await miniatura(buf), "jpg");
  const { rowCount } = await q(`UPDATE propuestas SET imagen = imagen || $3::jsonb WHERE id = $1 AND imagen->>'taskId' = $2`,
    [propuestaId, taskId, { estado: "lista", key, mini, error: null }]);
  if (!rowCount) { await storage.borrar(key); await storage.borrar(mini); return; }
  await repo.tocarEpisodio(p.episodio_id);
  await enviar("evaluar", { propuestaId, key, prioridad }, { prioridad });
}

// ---------- 4. Evaluar la portada (Claude con visión) ----------
async function hEvaluar({ propuestaId, key, prioridad }) {
  const p = await repo.propuesta(propuestaId);
  if (!p || p.archivada || p.imagen.key !== key) return;
  await q("UPDATE propuestas SET evaluando = true WHERE id = $1", [propuestaId]);
  const ep = await repo.episodio(p.episodio_id);
  const b64 = async (k) => ({ base64: (await paraClaude(await storage.leer(k))).toString("base64"), mime: "image/jpeg" });
  const refs = await Promise.all((await referencias(ep, p.data, { urls: false })).map(async (r) => ({ personaje: r.personaje, ...(await b64(r.fotos[0])) })));
  const ev = await ia.evaluarPortada({ imagen: await b64(key), propuesta: p.data, referencias: refs });
  const reintentar = !ev.aprobada && (p.imagen.intentos || 1) < 2;
  const { rowCount } = await q(`UPDATE propuestas SET evaluacion = $3, evaluando = false,
      imagen = CASE WHEN $4 THEN imagen || jsonb_build_object('autoReintento', $5::jsonb, 'estado', 'en_cola') ELSE imagen END
    WHERE id = $1 AND imagen->>'key' = $2`, [propuestaId, key, ev, reintentar, JSON.stringify(ev.problemas)]);
  await repo.tocarEpisodio(p.episodio_id);
  if (!rowCount) return;
  if (reintentar) return enviar("imagen", { propuestaId, usuario: p.imagen.usuario, extra: ev.problemas.join("; "), prioridad }, { prioridad });
  await quizaAutoElegir(p.episodio_id);
}

// En lotes con "elegir solo": cuando las 3 están revisadas, elige la de mejor calificación.
async function quizaAutoElegir(episodioId) {
  const ep = await one(`SELECT e.*, l.auto_elegir FROM episodios e LEFT JOIN lotes l ON l.id = e.lote_id WHERE e.id = $1`, [episodioId]);
  if (!ep?.auto_elegir || ep.elegida || ep.eligiendo) return;
  const ps = await all("SELECT * FROM propuestas WHERE episodio_id = $1 AND NOT archivada", [episodioId]);
  if (ps.some((p) => ["en_cola", "generando"].includes(p.imagen.estado) || p.evaluando || p.rehaciendo)) return;
  const listas = ps.filter((p) => p.imagen.estado === "lista");
  if (!listas.length) return;
  const mejor = listas.sort((a, b) => (b.evaluacion?.calificacion_final ?? b.data.calificacion.total) - (a.evaluacion?.calificacion_final ?? a.data.calificacion.total))[0];
  const { rowCount } = await q("UPDATE episodios SET eligiendo = true WHERE id = $1 AND NOT eligiendo AND elegida IS NULL", [episodioId]);
  if (rowCount) await enviar("paquete", { episodioId, propuestaId: mejor.id, usuario: ep.creado_por }, { prioridad: PRIORIDAD.lote });
}

// ---------- 5. Rehacer con la razón del equipo ----------
async function hRehacer({ propuestaId, objetivo, razones, comentario, usuario, prioridad }) {
  const p = await repo.propuesta(propuestaId);
  if (!p) return;
  const ep = await repo.episodio(p.episodio_id);
  const canal = await repo.canal(ep.canal);
  const nueva = await ia.rehacerPropuesta(ep, canal, p.data, { objetivo, razones, comentario }, await repo.feedbackReciente(ep.canal));
  await repo.sumarUso(usuario, "textos");
  const data = objetivo === "titulo"
    ? { ...p.data, titulo: nueva.titulo, formula: nueva.formula, porque_funciona: nueva.porque_funciona, riesgo: nueva.riesgo, calificacion: nueva.calificacion }
    : nueva;
  await tx(async (c) => {
    await c.query("INSERT INTO versiones (propuesta_id, data, imagen, evaluacion, feedback) VALUES ($1,$2,$3,$4,$5)",
      [propuestaId, p.data, p.imagen, p.evaluacion, { objetivo, razones, comentario }]);
    await c.query(`UPDATE propuestas SET data = $2, version = version + 1, evaluacion = NULL, rehaciendo = NULL, error_rehacer = NULL, editado = false,
        imagen = CASE WHEN $3 THEN '{"estado":"en_cola","intentos":0}'::jsonb ELSE imagen END WHERE id = $1`, [propuestaId, data, objetivo !== "titulo"]);
    await c.query("UPDATE episodios SET elegida = NULL, paquete = NULL, actualizado = now() WHERE id = $1 AND elegida = $2", [ep.id, propuestaId]);
    await c.query("UPDATE episodios SET actualizado = now() WHERE id = $1", [ep.id]);
  });
  if (objetivo === "titulo") {
    if (p.imagen.key) await enviar("evaluar", { propuestaId, key: p.imagen.key, prioridad }, { prioridad });
  } else await enviar("imagen", { propuestaId, usuario, prioridad }, { prioridad });
}

// ---------- 6. Paquete: descripción, tags, hashtags ----------
async function hPaquete({ episodioId, propuestaId, usuario }) {
  const ep = await repo.episodio(episodioId);
  const p = ep?.propuestas.find((x) => x.id === propuestaId);
  if (!p) return q("UPDATE episodios SET eligiendo = false WHERE id = $1", [episodioId]);
  const paquete = await ia.generarPaquete(ep, await repo.canal(ep.canal), p.data);
  await repo.sumarUso(usuario, "textos");
  await q("UPDATE episodios SET elegida = $2, paquete = $3, eligiendo = false, error = NULL, actualizado = now() WHERE id = $1", [episodioId, propuestaId, paquete]);
}

export async function iniciarWorkers() {
  const c = config.concurrency;
  await trabajo("propuestas", hPropuestas, async ({ episodioId }, e) =>
    q("UPDATE episodios SET estado = 'error', error = $2, actualizado = now() WHERE id = $1", [episodioId, msg(e, "No se pudieron crear las propuestas.")]), c.claude);
  await trabajo("imagen", hImagen, fallaImagen, c.images);
  await trabajo("revisar", hRevisar, fallaImagen, c.polling);
  await trabajo("evaluar", hEvaluar, async ({ propuestaId }) => {
    await q("UPDATE propuestas SET evaluando = false WHERE id = $1", [propuestaId]);
    const p = await repo.propuesta(propuestaId);
    if (p) await quizaAutoElegir(p.episodio_id);
  }, c.claude);
  await trabajo("rehacer", hRehacer, async ({ propuestaId }, e) => {
    await q("UPDATE propuestas SET rehaciendo = NULL, error_rehacer = $2 WHERE id = $1", [propuestaId, msg(e, "No se pudo rehacer. Intenta de nuevo.")]);
    const p = await repo.propuesta(propuestaId);
    if (p) await repo.tocarEpisodio(p.episodio_id);
  }, c.claude);
  await trabajo("paquete", hPaquete, async ({ episodioId }, e) =>
    q("UPDATE episodios SET eligiendo = false, error = $2, actualizado = now() WHERE id = $1", [episodioId, msg(e, "No se pudieron escribir la descripción y los tags.")]), c.claude);
  console.log(`Workers listos · Claude x${c.claude} · imágenes x${c.images}`);
}

export async function estadoCola() {
  const nombres = Object.keys(COLAS);
  const out = {};
  for (const n of nombres) {
    try { const [s] = await boss.getQueueStats(n); out[n] = { pendientes: s?.queuedCount ?? 0, activos: s?.activeCount ?? 0 }; }
    catch { out[n] = null; }
  }
  return out;
}
