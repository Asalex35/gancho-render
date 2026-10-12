import express from "express";
import multer from "multer";
import rateLimit from "express-rate-limit";
import { ZipArchive } from "archiver";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import { q, one, all, tx } from "./db.js";
import * as repo from "./repo.js";
import * as storage from "./storage.js";
import * as nb from "./ai/nanobanana.js";
import { enviar, PRIORIDAD, estadoCola } from "./jobs.js";
import { orden as ordenProveedores, PROVEEDORES } from "./ai/imagen.js";
import { tipoImagen, normalizarFoto, portadaFinal, portadaPropia, miniatura } from "./imagenes.js";
import { interpretar, PLANTILLA, normal } from "./lotes.js";
import * as ia from "./ai/claude.js";
import { transcripcionDisponible } from "./transcribir.js";
import * as biblioteca from "./biblioteca.js";
import { leerLinks, apiDisponible as youtubeApi, buscar as buscarYouTube, tendencias as tendenciasYouTube } from "./competencia.js";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  verificar, crearSesion, cerrarSesion, requiereSesion, soloAdmin, antiCsrf, usuarioDe,
  hashClave, validarClave, normalizarUsuario, olvidarUsuario,
} from "./auth.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const ROLES = ["transgresor", "victima", "testigo", "villano", "otro"];

const IDIOMAS = { es: "Español", en: "Inglés", pt: "Portugués" };
const LIMITE_VIDEO = 5 * 1024 ** 3; // límite de una subida simple a R2/S3

// Origen de R2/S3 para que el navegador pueda subir videos directo al bucket.
function origenesSubida() {
  if (!config.storage.endpoint) return config.storage.driver === "s3" ? " https://*.amazonaws.com" : "";
  const u = new URL(config.storage.endpoint);
  return ` ${u.origin} https://*.${u.host}`;
}

export function crearApp() {
  const app = express();
  const CONNECT = `'self'${origenesSubida()}`;
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // ---------- Encabezados de seguridad ----------
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": [
        "default-src 'self'", "img-src 'self' data: blob: https:", "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com", "script-src 'self'", `connect-src ${CONNECT}`,
        "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'",
      ].join("; "),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
    if (config.prod) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  });
  app.use(express.json({ limit: "3mb" })); // lotes grandes pegados como texto

  app.get("/salud", envolver(async (req, res) => { await q("SELECT 1"); res.json({ ok: true }); }));

  // ---------- Fotos firmadas para Nano Banana (modo local) ----------
  app.get("/pub/:carpeta/:archivo", (req, res) => {
    const key = `${req.params.carpeta}/${req.params.archivo}`;
    if (!storage.verificarEnlace(key, req.query.exp, req.query.sig)) return res.sendStatus(404);
    res.set("Cache-Control", "no-store").sendFile(storage.rutaLocal(key), (e) => e && !res.headersSent && res.sendStatus(404));
  });
  app.post(`/api/nb-callback/${config.callbackSecret}`, (req, res) => res.json({ ok: true }));

  // ---------- Login ----------
  const limiteLogin = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos. Espera 15 minutos." } });
  app.get("/login", envolver(async (req, res) => ((await usuarioDe(req)) ? res.redirect("/") : res.sendFile(path.join(PUBLIC, "login.html")))));
  app.post("/api/login", limiteLogin, antiCsrf, envolver(async (req, res) => {
    const u = await verificar(req.body?.usuario, req.body?.clave);
    if (!u) return res.status(401).json({ error: "Usuario o contraseña incorrectos." });
    crearSesion(res, u);
    res.json({ ok: true });
  }));
  app.post("/api/logout", antiCsrf, (req, res) => { cerrarSesion(res); res.json({ ok: true }); });
  app.use("/assets", express.static(path.join(PUBLIC, "assets"), { maxAge: 0, etag: true }));

  // ================= Todo lo de abajo requiere sesión =================
  app.use(requiereSesion, antiCsrf);
  app.use("/api", rateLimit({ windowMs: 60e3, limit: 300, standardHeaders: true, legacyHeaders: false, keyGenerator: (req) => req.user.id }));

  app.get("/", (req, res) => res.sendFile(path.join(PUBLIC, "index.html")));
  app.get("/media/:carpeta/:archivo", envolver(async (req, res) => {
    const key = `${req.params.carpeta}/${req.params.archivo}`;
    if (!storage.keyValida(key)) return res.sendStatus(404);
    if (storage.esS3) return res.redirect(302, await storage.urlPrivada(key));
    res.set("Cache-Control", "private, max-age=604800, immutable").sendFile(storage.rutaLocal(key), (e) => e && !res.headersSent && res.sendStatus(404));
  }));

  app.get("/api/me", envolver(async (req, res) => {
    let creditos = null;
    try { creditos = await nb.creditos(); } catch {}
    res.json({
      usuario: req.usuario, rol: req.user.rol, creditos, uso: await repo.usoHoy(req.usuario),
      limites: config.limits, creditosPorImagen: config.creditsPerImage, refsPublicas: config.refsPublicas,
      canales: (await repo.canales()).filter((c) => c.activo).map((c) => ({ id: c.id, nombre: c.nombre, logo: c.logo_key, idioma: c.idioma, modelo: c.modelo })),
      idiomas: IDIOMAS, transcripcion: transcripcionDisponible(), subidaDirecta: storage.esS3,
      modelos: Object.fromEntries(Object.entries(nb.MODELOS).map(([k, v]) => [k, v.nombre])),
    });
  }));

  // ---------- Actores ----------
  const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 8 } });
  async function guardarFotos(files) {
    const keys = [];
    for (const f of files || []) {
      if (!tipoImagen(f.buffer)) throw publico(`"${f.originalname}" no es JPG, PNG ni WEBP.`);
      keys.push(await storage.guardar("actores", await normalizarFoto(f.buffer), "jpg"));
    }
    return keys;
  }
  app.get("/api/actores", envolver(async (req, res) => {
    res.json(await all(`SELECT a.id, a.nombre, a.fotos, a.creado_por, a.creado, a.auto,
        (SELECT count(*)::int FROM actor_caras ac WHERE ac.actor_id = a.id) AS n_caras,
        (SELECT key FROM actor_caras ac WHERE ac.actor_id = a.id ORDER BY calidad DESC LIMIT 1) AS mejor_cara
      FROM actores a ORDER BY a.auto DESC, lower(a.nombre)`));
  }));
  app.post("/api/actores", subir.array("fotos", 8), envolver(async (req, res) => {
    const nombre = limpiar(req.body.nombre, 80);
    if (!nombre) throw publico("Escribe el nombre del actor.");
    if (!req.files?.length) throw publico("Sube al menos una foto.");
    const fotos = await guardarFotos(req.files);
    const a = await one("INSERT INTO actores (nombre, fotos, creado_por) VALUES ($1, $2, $3) RETURNING *", [nombre, JSON.stringify(fotos), req.usuario]);
    for (const f of fotos) biblioteca.procesarFoto(a.id, f).catch((e) => console.warn("Biblioteca:", e.message)); // huella en segundo plano
    res.json(a);
  }));
  app.post("/api/actores/:id/fotos", subir.array("fotos", 8), envolver(async (req, res) => {
    const fotos = await guardarFotos(req.files);
    const a = await one("UPDATE actores SET fotos = fotos || $2::jsonb WHERE id = $1 RETURNING *", [uuid(req.params.id), JSON.stringify(fotos)]);
    if (!a) throw publico("Ese actor no existe.", 404);
    for (const f of fotos) biblioteca.procesarFoto(a.id, f).catch((e) => console.warn("Biblioteca:", e.message));
    res.json(a);
  }));
  app.patch("/api/actores/:id", envolver(async (req, res) => {
    const a = await one("SELECT * FROM actores WHERE id = $1", [uuid(req.params.id)]);
    if (!a) throw publico("Ese actor no existe.", 404);
    if (Array.isArray(req.body.quitarFotos) && req.body.quitarFotos.length) puedeBorrar(req, a.creado_por);
    const nombre = limpiar(req.body.nombre, 80) || a.nombre;
    let fotos = a.fotos;
    if (Array.isArray(req.body.quitarFotos)) {
      const quitar = req.body.quitarFotos.filter((k) => fotos.includes(k));
      fotos = fotos.filter((k) => !quitar.includes(k));
      for (const k of quitar) await storage.borrar(k);
    }
    if (Array.isArray(req.body.quitarFotos)) await q("DELETE FROM actor_caras WHERE actor_id = $1 AND foto_key = ANY($2)", [a.id, req.body.quitarFotos]);
    // Al ponerle nombre a un actor creado por Gancho, deja de estar "sin nombre".
    res.json(await one("UPDATE actores SET nombre = $2, fotos = $3, auto = CASE WHEN $4 THEN false ELSE auto END WHERE id = $1 RETURNING *",
      [a.id, nombre, JSON.stringify(fotos), Boolean(limpiar(req.body.nombre, 80))]));
  }));
  app.delete("/api/actores/:id", envolver(async (req, res) => {
    const dueno = await one("SELECT creado_por FROM actores WHERE id = $1", [uuid(req.params.id)]);
    if (dueno) puedeBorrar(req, dueno.creado_por);
    const a = await one("DELETE FROM actores WHERE id = $1 RETURNING fotos", [req.params.id]);
    for (const k of a?.fotos || []) await storage.borrar(k);
    res.json({ ok: true });
  }));

  // ---------- Episodios ----------
  async function armarCast(castIn) {
    if (!Array.isArray(castIn)) return [];
    castIn = castIn.filter((c) => c && typeof c === "object");
    const ids = castIn.map((c) => c.actorId).filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id || ""));
    const actores = ids.length ? await all("SELECT id, nombre, fotos FROM actores WHERE id = ANY($1)", [ids]) : [];
    return castIn.slice(0, 8).map((c) => {
      const actor = actores.find((a) => a.id === c.actorId);
      const personaje = limpiar(c.personaje, 60);
      if (!personaje) return null;
      // Cuadros del video (flujo automático): solo llaves válidas de la carpeta "cuadros".
      const fotos = (Array.isArray(c.fotos) ? c.fotos : []).filter((k) => typeof k === "string" && k.startsWith("cuadros/") && storage.keyValida(k)).slice(0, 3);
      return { actorId: actor?.id || null, actorNombre: actor?.nombre || null, personaje, edad: limpiar(c.edad, 20),
        rol: ROLES.includes(c.rol) ? c.rol : "otro", vestuario: limpiar(c.vestuario, 200), descripcion: limpiar(c.descripcion, 300), hablante: limpiar(c.hablante, 4) || null,
        fotos, tieneFotos: Boolean(actor?.fotos?.length || fotos.length), reconocido: Boolean(c.reconocido && actor),
        // Huella de la cara (128 números) del flujo automático: se conserva para medir el parecido.
        huella: Array.isArray(c.huella) && c.huella.length === 128 && c.huella.every((x) => typeof x === "number" && Number.isFinite(x)) ? c.huella : null };
    }).filter(Boolean);
  }
  async function datosEpisodio(b) {
    const canal = (await repo.canal(b.canal)) ? b.canal : (await repo.canales())[0].id;
    const brief = {
      sinopsis: limpiar(b.sinopsis, 4000), giro: limpiar(b.giro, 600), momento: limpiar(b.momento, 600),
      desenlace: limpiar(b.desenlace, 600), escenario: limpiar(b.escenario, 200), notas: limpiar(b.notas, 600),
      cuadros_momento: (Array.isArray(b.cuadros_momento) ? b.cuadros_momento : []).filter((k) => typeof k === "string" && k.startsWith("cuadros/") && storage.keyValida(k)).slice(0, 2),
    };
    const dur = Math.round(Number(b.duracion_min));
    if (b.duracion_min !== undefined && b.duracion_min !== "" && b.duracion_min !== null && !(dur >= 1 && dur <= 600)) throw publico("La duración debe ser en minutos, entre 1 y 600.");
    if (dur >= 1 && dur <= 600) brief.duracion_min = dur;
    if (!brief.sinopsis) throw publico("Falta la sinopsis.");
    return { canal, modelo: Object.hasOwn(nb.MODELOS, b.modelo || "") ? b.modelo : "pro", titulo: limpiar(b.titulo, 120) || brief.sinopsis.slice(0, 60), brief, cast: await armarCast(b.cast) };
  }

  app.get("/api/episodios", envolver(async (req, res) => {
    const filas = await all(`
      SELECT e.id, e.titulo, e.canal, e.estado, e.actualizado, e.creado_por, e.lote_id, e.elegida,
        (SELECT coalesce(p.imagen->>'mini', p.imagen->>'key') FROM propuestas p WHERE p.episodio_id = e.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista'
         ORDER BY (p.id = e.elegida) DESC, p.slot LIMIT 1) AS portada
      FROM episodios e WHERE e.lote_id IS NULL AND e.origen = 'manual' ORDER BY e.actualizado DESC LIMIT 60`);
    res.json(filas);
  }));
  app.get("/api/episodios/:id", envolver(async (req, res) => {
    const ep = await repo.episodio(uuid(req.params.id));
    if (!ep) throw publico("Ese episodio no existe.", 404);
    res.json(repo.publicarEpisodio(ep));
  }));
  app.post("/api/episodios", envolver(async (req, res) => {
    const d = await datosEpisodio(req.body);
    res.json(await one(`INSERT INTO episodios (titulo, canal, modelo, brief, "cast", creado_por) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [d.titulo, d.canal, d.modelo, d.brief, JSON.stringify(d.cast), req.usuario]));
  }));
  app.put("/api/episodios/:id", envolver(async (req, res) => {
    const d = await datosEpisodio(req.body);
    const ep = await one(`UPDATE episodios SET titulo=$2, canal=$3, modelo=$4, brief=$5, "cast"=$6, actualizado=now() WHERE id=$1 RETURNING *`,
      [uuid(req.params.id), d.titulo, d.canal, d.modelo, d.brief, JSON.stringify(d.cast)]);
    if (!ep) throw publico("Ese episodio no existe.", 404);
    res.json(ep);
  }));
  app.delete("/api/episodios/:id", envolver(async (req, res) => {
    const ep = await one("SELECT creado_por FROM episodios WHERE id = $1", [uuid(req.params.id)]);
    if (!ep) return res.json({ ok: true });
    puedeBorrar(req, ep.creado_por);
    await borrarEpisodios("e.id = $1", [req.params.id]);
    res.json({ ok: true });
  }));

  async function generar(ep, usuario, prioridad) {
    // Un video automático sin brief (su lectura falló) no se puede generar: hay que reintentar el video.
    const r = await q(`UPDATE episodios SET estado = 'en_cola', error = NULL, aprobacion = NULL, actualizado = now()
                       WHERE id = $1 AND estado NOT IN ('en_cola', 'pensando', 'procesando') AND NOT eligiendo
                         AND (origen <> 'auto' OR video->>'etapa' = 'listo') RETURNING id`, [ep]);
    if (!r.rowCount) return false;
    await enviar("propuestas", { episodioId: ep, usuario, prioridad }, { prioridad });
    return true;
  }
  app.post("/api/episodios/:id/generar", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    await reservarCupo(req.usuario, 3);
    let ok = false;
    try { ok = await generar(id, req.usuario, PRIORIDAD.interactiva); } catch (e) { await devolverCupo(req.usuario, 3); throw e; }
    if (!ok) { await devolverCupo(req.usuario, 3); throw publico("No se puede generar ahora: se está procesando, o es un video que hay que reintentar.", 409); }
    res.status(202).json({ ok: true });
  }));

  // Portada final 1280x720 con logo, lista para YouTube
  // ---------- Modo manual ----------
  // Portada hecha por el equipo (diseñador): se guarda como una propuesta más y Claude la califica.
  app.post("/api/episodios/:id/portada-propia", subir.single("imagen"), envolver(async (req, res) => {
    const ep = await repo.episodio(uuid(req.params.id));
    if (!ep) throw publico("Ese episodio no existe.", 404);
    if (["en_cola", "pensando", "procesando"].includes(ep.estado)) throw publico("Espera a que termine de generar.", 409);
    if (!req.file || !tipoImagen(req.file.buffer)) throw publico("Sube la portada en JPG, PNG o WEBP.");
    const buf = await portadaPropia(req.file.buffer);
    const key = await storage.guardar("portadas", buf, "jpg");
    const mini = await storage.guardar("mini", await miniatura(buf), "jpg");
    const titulo = limpiar(req.body.titulo, 100) || ep.propuestas.find((x) => x.id === ep.elegida)?.data.titulo || ep.propuestas[0]?.data.titulo || ep.titulo;
    const data = {
      titulo, traduccion: "", formula: "Libre", composicion: "Otra", concepto: "Portada subida por el equipo", personajes_en_portada: [],
      prompt_imagen: "", calificacion: { total: 0, tabu: 0, especificidad: 0, misterio: 0, claridad_visual: 0 }, porque_funciona: [], riesgo: "", propia: true,
    };
    const p = await one(`INSERT INTO propuestas (episodio_id, slot, data, imagen)
        VALUES ($1, (SELECT coalesce(max(slot), -1) + 1 FROM propuestas WHERE episodio_id = $1 AND NOT archivada), $2, $3) RETURNING id`,
      [ep.id, data, { estado: "lista", key, mini, proveedor: "manual", intentos: 1, usuario: req.usuario }]);
    await q("UPDATE episodios SET estado = CASE WHEN estado IN ('borrador','error') THEN 'listo' ELSE estado END, actualizado = now() WHERE id = $1", [ep.id]);
    await enviar("evaluar", { propuestaId: p.id, key, prioridad: PRIORIDAD.interactiva, sinReintento: true });
    res.json({ ok: true });
  }));

  // Editar a mano descripción, tags y hashtags del paquete final.
  app.put("/api/episodios/:id/paquete", envolver(async (req, res) => {
    const ep = await one("SELECT paquete FROM episodios WHERE id = $1", [uuid(req.params.id)]);
    if (!ep?.paquete) throw publico("Primero elige una portada.", 409);
    const lista = (v, sep) => String(v || "").split(sep).map((x) => limpiar(x, 100)).filter(Boolean);
    const cambios = {
      descripcion: limpiar(req.body.descripcion, 5000),
      tags: lista(req.body.tags, /,/).slice(0, 40),
      hashtags: lista(req.body.hashtags, /[\s,]+/).filter((h) => h.startsWith("#")).slice(0, 15),
      editadoAMano: true, desactualizado: false,
    };
    if (!cambios.descripcion) throw publico("La descripción no puede quedar vacía.");
    if (cambios.tags.join(", ").length > 500) throw publico("Los tags pasan de 500 caracteres (el máximo de YouTube).");
    await q("UPDATE episodios SET paquete = paquete || $2::jsonb, actualizado = now() WHERE id = $1", [req.params.id, cambios]);
    res.json({ ok: true });
  }));

  app.get("/api/episodios/:id/portada.jpg", envolver(async (req, res) => {
    const ep = await repo.episodio(uuid(req.params.id));
    const p = ep?.propuestas.find((x) => x.id === (req.query.propuesta || ep.elegida));
    if (!p?.imagen?.key) throw publico("No hay portada lista.", 404);
    const canal = await repo.canal(ep.canal);
    const buf = await portadaFinal(p.imagen.key, req.query.logo === "0" ? null : canal.logo_key);
    res.set({ "Content-Type": "image/jpeg", "Content-Disposition": adjunto(ep.titulo, "jpg") }).send(buf);
  }));

  // ---------- Propuestas ----------
  async function propuestaConEpisodio(id) {
    const p = await one(`SELECT p.*, e.canal, e.elegida, e.paquete, e.eligiendo FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE p.id = $1 AND NOT p.archivada`, [uuid(id)]);
    if (!p) throw publico("Esa propuesta no existe.", 404);
    return p;
  }
  app.post("/api/propuestas/:id/rehacer", envolver(async (req, res) => {
    const objetivo = ["portada", "titulo", "ambos"].includes(req.body.objetivo) ? req.body.objetivo : "ambos";
    const razones = (Array.isArray(req.body.razones) ? req.body.razones : []).map((r) => limpiar(r, 80)).filter(Boolean).slice(0, 8);
    const comentario = limpiar(req.body.comentario, 500);
    if (!razones.length && !comentario) throw publico("Dinos por qué no te gustó para poder mejorarla.");
    const p = await propuestaConEpisodio(req.params.id);
    if (p.eligiendo) throw publico("Espera a que termine de escribir la descripción.", 409);
    if (p.data.propia && objetivo !== "titulo") throw publico("Esta portada la subió el equipo: solo se puede rehacer el título.");
    if (objetivo !== "titulo") await reservarCupo(req.usuario, 1);
    const r = await q("UPDATE propuestas SET rehaciendo = $2, error_rehacer = NULL WHERE id = $1 AND rehaciendo IS NULL", [p.id, objetivo]);
    if (!r.rowCount) { if (objetivo !== "titulo") await devolverCupo(req.usuario, 1); throw publico("Ya se está rehaciendo.", 409); }
    await q("INSERT INTO feedback (canal, episodio_id, usuario, titulo, objetivo, razones, comentario) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [p.canal, p.episodio_id, req.usuario, p.data.titulo, objetivo, JSON.stringify(razones), comentario]);
    await repo.tocarEpisodio(p.episodio_id);
    await enviar("rehacer", { propuestaId: p.id, objetivo, razones, comentario, usuario: req.usuario, prioridad: PRIORIDAD.interactiva });
    res.status(202).json({ ok: true });
  }));
  app.get("/api/propuestas/:id/versiones", envolver(async (req, res) => {
    res.json(await all("SELECT id, data, imagen, evaluacion, feedback, creado FROM versiones WHERE propuesta_id = $1 ORDER BY creado DESC", [uuid(req.params.id)]));
  }));
  app.post("/api/propuestas/:id/restaurar", envolver(async (req, res) => {
    const p = await propuestaConEpisodio(req.params.id);
    if (p.rehaciendo || p.eligiendo) throw publico("Espera a que termine lo que se está haciendo.", 409);
    let reencolar = false;
    await tx(async (c) => {
      const { rows: [v] } = await c.query("DELETE FROM versiones WHERE id = $1 AND propuesta_id = $2 RETURNING *", [uuid(req.body.versionId), p.id]);
      if (!v) throw publico("Esa versión no existe.", 404);
      // Una versión guardada a media generación no tiene imagen: se vuelve a pintar.
      let img = v.imagen;
      if (!img || !["lista", "error"].includes(img.estado)) { img = { estado: "en_cola", intentos: 0, usuario: req.usuario }; reencolar = true; }
      await c.query("INSERT INTO versiones (propuesta_id, data, imagen, evaluacion) VALUES ($1,$2,$3,$4)", [p.id, p.data, p.imagen, p.evaluacion]);
      await c.query("UPDATE propuestas SET data = $2, imagen = $3, evaluacion = $4, evaluando = false, version = version + 1, editado = false WHERE id = $1",
        [p.id, v.data, img, reencolar ? null : v.evaluacion]);
      await c.query("UPDATE episodios SET elegida = NULL, paquete = NULL, aprobacion = NULL WHERE id = $1 AND elegida = $2", [p.episodio_id, p.id]);
      await c.query("UPDATE episodios SET actualizado = now() WHERE id = $1", [p.episodio_id]);
    });
    if (reencolar) await enviar("imagen", { propuestaId: p.id, usuario: req.usuario, prioridad: PRIORIDAD.interactiva });
    res.json({ ok: true });
  }));
  app.patch("/api/propuestas/:id", envolver(async (req, res) => {
    if (typeof req.body.titulo !== "string") throw publico("Título inválido.");
    const titulo = limpiar(req.body.titulo, 100);
    if (!titulo) throw publico("El título no puede quedar vacío.");
    const p = await propuestaConEpisodio(req.params.id);
    await q("UPDATE propuestas SET data = data || jsonb_build_object('titulo', $2::text), editado = true WHERE id = $1", [p.id, titulo]);
    if (p.elegida === p.id && p.paquete) await q("UPDATE episodios SET paquete = paquete || '{\"desactualizado\":true}'::jsonb WHERE id = $1", [p.episodio_id]);
    await repo.tocarEpisodio(p.episodio_id);
    res.json({ ok: true });
  }));
  app.post("/api/propuestas/:id/elegir", envolver(async (req, res) => {
    const p = await propuestaConEpisodio(req.params.id);
    if (p.imagen.estado !== "lista") throw publico("Espera a que la portada esté lista.");
    if (p.rehaciendo) throw publico("Espera a que termine de rehacerse.", 409);
    const r = await q("UPDATE episodios SET eligiendo = true, actualizado = now() WHERE id = $1 AND NOT eligiendo", [p.episodio_id]);
    if (!r.rowCount) throw publico("Ya se está escribiendo el paquete.", 409);
    await enviar("paquete", { episodioId: p.episodio_id, propuestaId: p.id, usuario: req.usuario }, { prioridad: PRIORIDAD.interactiva });
    res.status(202).json({ ok: true });
  }));
  app.post("/api/propuestas/:id/reintentar", envolver(async (req, res) => {
    const p = await propuestaConEpisodio(req.params.id);
    await reservarCupo(req.usuario, 1);
    const r = await q(`UPDATE propuestas SET imagen = imagen || jsonb_build_object('estado','en_cola','error',null,'taskId',null,'evitar','[]'::jsonb,'usuario',$2::text)
      WHERE id = $1 AND imagen->>'estado' = 'error' AND rehaciendo IS NULL`, [p.id, req.usuario]);
    if (!r.rowCount) { await devolverCupo(req.usuario, 1); throw publico("Esta imagen no está en error.", 409); }
    await repo.tocarEpisodio(p.episodio_id);
    await enviar("imagen", { propuestaId: p.id, usuario: req.usuario, prioridad: PRIORIDAD.interactiva });
    res.json({ ok: true });
  }));

  // ---------- Lotes (modo masivo) ----------
  app.get("/api/plantilla.csv", (req, res) => {
    const csv = PLANTILLA.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    res.set({ "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="plantilla-gancho.csv"' }).send(`﻿${csv}`);
  });
  app.post("/api/lotes/previsualizar", envolver(async (req, res) => {
    const r = await interpretar(req.body.texto, await repo.canales());
    if (r.filas.length > config.limits.maxEpisodesPerBatch) r.aviso = `Máximo ${config.limits.maxEpisodesPerBatch} episodios por lote. Divide la lista.`;
    res.json(r);
  }));
  app.post("/api/lotes", envolver(async (req, res) => {
    const canales = await repo.canales();
    const canal = canales.find((c) => c.id === req.body.canal)?.id;
    if (!canal) throw publico("Elige el canal del lote.");
    const modelo = Object.hasOwn(nb.MODELOS, req.body.modelo || "") ? req.body.modelo : "pro";
    const { filas, error } = await interpretar(req.body.texto, canales);
    if (error) throw publico(error);
    const validas = filas.filter((f) => !f.errores.length);
    if (!validas.length) throw publico("No hay filas válidas.");
    if (validas.length > config.limits.maxEpisodesPerBatch) throw publico(`Máximo ${config.limits.maxEpisodesPerBatch} episodios por lote.`);
    await reservarCupo(req.usuario, validas.length * 3);
    let lote;
    try { lote = await tx(async (c) => {
      const { rows: [l] } = await c.query("INSERT INTO lotes (nombre, canal, modelo, auto_elegir, creado_por) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [limpiar(req.body.nombre, 120) || `Lote ${new Date().toLocaleDateString("es-MX")}`, canal, modelo, Boolean(req.body.autoElegir), req.usuario]);
      l.episodios = [];
      for (const [i, f] of validas.entries()) {
        // El reparto de la hoja pasa al cast (Claude solo completa edad, rol y vestuario).
        const cast = f.reparto.map((r) => ({ personaje: r.personaje, actorId: r.actorId, actorNombre: r.actorNombre, tieneFotos: Boolean(r.actorId), rol: "", edad: "", vestuario: "" }));
        const { rows: [e] } = await c.query(`INSERT INTO episodios (lote_id, orden, titulo, canal, modelo, brief, "cast", estado, origen, creado_por)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'en_cola','lote',$8) RETURNING id`, [l.id, i, f.nombre, f.canal || canal, modelo, f.brief, JSON.stringify(cast), req.usuario]);
        l.episodios.push(e.id);
      }
      return l;
    }); } catch (e) { await devolverCupo(req.usuario, validas.length * 3); throw e; }
    for (const id of lote.episodios) await enviar("propuestas", { episodioId: id, usuario: req.usuario, prioridad: PRIORIDAD.lote }, { prioridad: PRIORIDAD.lote });
    res.json({ id: lote.id, episodios: lote.episodios.length });
  }));

  const RESUMEN_LOTE = `
    count(e.id)::int AS total,
    count(e.id) FILTER (WHERE e.elegida IS NOT NULL)::int AS elegidos,
    count(e.id) FILTER (WHERE e.estado = 'error')::int AS errores,
    count(e.id) FILTER (WHERE e.estado IN ('en_cola','pensando'))::int AS pensando`;
  app.get("/api/lotes", envolver(async (req, res) => {
    res.json(await all(`SELECT l.*, ${RESUMEN_LOTE},
        (SELECT count(*)::int FROM propuestas p JOIN episodios e2 ON e2.id = p.episodio_id
          WHERE e2.lote_id = l.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista') AS imagenes_listas
      FROM lotes l LEFT JOIN episodios e ON e.lote_id = l.id GROUP BY l.id ORDER BY l.creado DESC LIMIT 50`));
  }));
  app.get("/api/lotes/:id", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    const lote = await one(`SELECT l.*, ${RESUMEN_LOTE} FROM lotes l LEFT JOIN episodios e ON e.lote_id = l.id WHERE l.id = $1 GROUP BY l.id`, [id]);
    if (!lote) throw publico("Ese lote no existe.", 404);
    const eps = await all(`SELECT id, orden, titulo, estado, error, elegida, eligiendo, paquete IS NOT NULL AS tiene_paquete, actualizado FROM episodios WHERE lote_id = $1 ORDER BY orden`, [id]);
    const props = await all(`SELECT p.id, p.episodio_id, p.slot, p.data->>'titulo' AS titulo, (p.data->'calificacion'->>'total')::int AS estimada,
        (p.evaluacion->>'calificacion_final')::int AS final, p.imagen->>'estado' AS estado, p.imagen->>'mini' AS mini, p.imagen->>'key' AS key,
        p.evaluando, p.rehaciendo
      FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE e.lote_id = $1 AND NOT p.archivada ORDER BY p.slot`, [id]);
    for (const e of eps) e.propuestas = props.filter((p) => p.episodio_id === e.id);
    res.json({ ...lote, episodios: eps });
  }));
  app.post("/api/lotes/:id/elegir-mejores", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    const eps = await all(`SELECT e.id,
        (SELECT p.id FROM propuestas p WHERE p.episodio_id = e.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista' AND p.rehaciendo IS NULL
          ORDER BY coalesce((p.evaluacion->>'calificacion_final')::int, (p.data->'calificacion'->>'total')::int) DESC LIMIT 1) AS mejor
      FROM episodios e WHERE e.lote_id = $1 AND e.elegida IS NULL AND NOT e.eligiendo AND e.estado = 'listo'`, [id]);
    let n = 0;
    for (const e of eps.filter((x) => x.mejor)) {
      const r = await q("UPDATE episodios SET eligiendo = true WHERE id = $1 AND NOT eligiendo", [e.id]);
      if (r.rowCount) { n++; await enviar("paquete", { episodioId: e.id, propuestaId: e.mejor, usuario: req.usuario }, { prioridad: PRIORIDAD.lote }); }
    }
    res.json({ elegidos: n });
  }));
  app.post("/api/lotes/:id/reintentar", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    const eps = await all("SELECT id FROM episodios WHERE lote_id = $1 AND estado = 'error'", [id]);
    const imgs = await all(`SELECT p.id FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE e.lote_id = $1 AND NOT p.archivada AND p.imagen->>'estado' = 'error'`, [id]);
    await reservarCupo(req.usuario, eps.length * 3 + imgs.length);
    let usados = 0;
    try {
      for (const e of eps) if (await generar(e.id, req.usuario, PRIORIDAD.lote)) usados += 3;
      for (const p of imgs) {
        const r = await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"en_cola","error":null,"taskId":null,"evitar":[],"reparaciones":0}'::jsonb WHERE id = $1 AND imagen->>'estado' = 'error'`, [p.id]);
        if (!r.rowCount) continue;
        await enviar("imagen", { propuestaId: p.id, usuario: req.usuario, prioridad: PRIORIDAD.lote }, { prioridad: PRIORIDAD.lote });
        usados += 1;
      }
    } finally { await devolverCupo(req.usuario, eps.length * 3 + imgs.length - usados); }
    res.json({ episodios: eps.length, imagenes: imgs.length });
  }));
  app.delete("/api/lotes/:id", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    const l = await one("SELECT creado_por FROM lotes WHERE id = $1", [id]);
    if (l) puedeBorrar(req, l.creado_por);
    await borrarEpisodios("e.lote_id = $1", [id]);
    await q("DELETE FROM lotes WHERE id = $1", [id]);
    res.json({ ok: true });
  }));

  // ZIP con portadas finales + CSV con títulos, descripciones y tags
  let exportando = 0;
  app.get("/api/lotes/:id/exportar.zip", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    if (exportando >= 2) throw publico("Hay otras descargas en curso. Intenta en un minuto.", 429);
    exportando++;
    res.on("close", () => exportando--);
    const lote = await one("SELECT l.*, c.logo_key FROM lotes l JOIN canales c ON c.id = l.canal WHERE l.id = $1", [id]);
    if (!lote) throw publico("Ese lote no existe.", 404);
    const eps = await all(`SELECT e.*, p.imagen->>'key' AS key, p.data->>'titulo' AS titulo_yt, c.logo_key AS logo
      FROM episodios e JOIN propuestas p ON p.id = e.elegida JOIN canales c ON c.id = e.canal
      WHERE e.lote_id = $1 AND e.paquete IS NOT NULL ORDER BY e.orden`, [id]);
    if (!eps.length) throw publico("Todavía no hay episodios elegidos en este lote.");
    res.set({ "Content-Type": "application/zip", "Content-Disposition": adjunto(lote.nombre, "zip") });
    const zip = new ZipArchive({ zlib: { level: 1 } });
    zip.on("error", (e) => { console.error(e); res.destroy(e); });
    zip.pipe(res);
    const filas = [["orden", "archivo", "nombre_interno", "titulo", "titulo_ab_1", "titulo_ab_2", "descripcion", "tags", "hashtags"]];
    for (const e of eps) {
      if (!e.key || !storage.keyValida(e.key)) continue;
      const archivo = `${String(e.orden + 1).padStart(3, "0")} - ${archivoSeguro(e.titulo)}.jpg`;
      let buf;
      try { buf = await portadaFinal(e.key, e.logo); } catch (er) { console.error("ZIP:", er.message); continue; }
      const listo = new Promise((ok) => zip.once("entry", ok));
      zip.append(buf, { name: `portadas/${archivo}` });
      await listo; // no acumular todo en memoria si el cliente descarga lento
      const k = e.paquete;
      filas.push([e.orden + 1, archivo, e.titulo, e.titulo_yt, k.titulos_alternos?.[0] || "", k.titulos_alternos?.[1] || "", k.descripcion, (k.tags || []).join(", "), (k.hashtags || []).join(" ")]);
    }
    const csv = filas.map((r) => r.map(celda).join(",")).join("\r\n");
    zip.append(`\uFEFF${csv}`, { name: "titulos-descripciones-tags.csv" });
    await zip.finalize();
  }));

  // ---------- Flujo automático: del video a la portada ----------
  app.get("/api/auto", envolver(async (req, res) => {
    res.json(await all(`
      SELECT e.id, e.titulo, e.canal, e.estado, e.error, e.aprobacion, e.elegida, e.eligiendo, e.actualizado, e.creado_por,
        e.video->>'etapa' AS etapa, e.video->>'nombre' AS archivo, (e.video->>'duracion')::int AS duracion, e.video->>'fuente' AS fuente,
        (SELECT coalesce(p.imagen->>'mini', p.imagen->>'key') FROM propuestas p WHERE p.episodio_id = e.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista'
          ORDER BY (p.id = e.elegida) DESC, coalesce((p.evaluacion->>'calificacion_final')::int, 0) DESC LIMIT 1) AS portada,
        (SELECT max(coalesce((p.evaluacion->>'calificacion_final')::int, (p.data->'calificacion'->>'total')::int)) FROM propuestas p
          WHERE p.episodio_id = e.id AND NOT p.archivada) AS mejor
      FROM episodios e WHERE e.origen = 'auto' ORDER BY e.creado DESC LIMIT 100`));
  }));

  // 1) Pide dónde subir el video. Con R2/S3 el navegador sube directo al bucket.
  app.post("/api/auto/subida", envolver(async (req, res) => {
    const ext = String(req.body.nombre || "").split(".").pop().toLowerCase();
    if (!storage.EXT_VIDEO.includes(ext)) throw publico("Sube un video MP4, MOV, WEBM o MKV.");
    if (Number(req.body.tamano) > LIMITE_VIDEO) throw publico("El video pesa más de 5 GB. Expórtalo más ligero (H.264, 1080p).");
    await hayCupo(req.usuario, 3);
    const key = storage.nuevaKey("videos", ext);
    if (storage.esS3) return res.json({ key, url: await storage.urlDeSubida(key), tipo: storage.mimeDe(key) });
    res.json({ key, local: true });
  }));
  // 1b) Sin R2/S3: el video llega al servidor como flujo y se guarda en disco.
  app.put("/api/auto/subida/:carpeta/:archivo", envolver(async (req, res) => {
    const key = `${req.params.carpeta}/${req.params.archivo}`;
    if (storage.esS3 || req.params.carpeta !== "videos" || !storage.keyValida(key)) throw publico("Subida no válida.");
    if (Number(req.get("content-length") || 0) > LIMITE_VIDEO) throw publico("El video pesa más de 5 GB.", 413);
    if (await storage.existe(key)) throw publico("Ese archivo ya existe.", 409);
    const tmp = `${os.tmpdir()}/gancho-subida-${crypto.randomBytes(8).toString("hex")}`;
    let bytes = 0;
    req.on("data", (d) => { bytes += d.length; if (bytes > LIMITE_VIDEO) req.destroy(new Error("demasiado grande")); });
    try {
      await pipeline(req, fs.createWriteStream(tmp, { flags: "wx" }));
      await storage.guardarDesdeArchivo(key, tmp);
    } catch (e) {
      await fs.promises.rm(tmp, { force: true });
      throw publico(e.code === "ENOSPC" ? "El servidor se quedó sin espacio." : "Se cortó la subida del video.", 400);
    }
    res.json({ ok: true, bytes });
  }));
  // 2) Crea el episodio y lo manda a la cola.
  app.post("/api/auto/episodios", envolver(async (req, res) => {
    const canal = await repo.canal(req.body.canal);
    if (!canal) throw publico("Elige el canal.");
    const key = String(req.body.key || "");
    if (!key.startsWith("videos/") || !(await storage.existe(key))) throw publico("No encontré el video subido. Intenta de nuevo.");
    if (await one("SELECT 1 FROM episodios WHERE video->>'key' = $1", [key])) throw publico("Ese video ya se registró.", 409);
    await reservarCupo(req.usuario, 3);
    const nombre = limpiar(req.body.nombreArchivo, 160);
    let ep;
    try { ep = await one(`INSERT INTO episodios (titulo, canal, modelo, brief, estado, origen, video, creado_por)
        VALUES ($1,$2,$3,$4,'procesando','auto',$5,$6) RETURNING id`,
      [`Video: ${nombre.replace(/\.[^.]+$/, "")}`.slice(0, 120), canal.id, canal.modelo, { sinopsis: "", notas: limpiar(req.body.notas, 600) },
        { key, nombre, etapa: "en_cola", subtitulos: limpiar(req.body.subtitulos, 400000) || null }, req.usuario]);
    } catch (e) { await devolverCupo(req.usuario, 3); throw e; }
    await enviar("ingesta", { episodioId: ep.id, usuario: req.usuario }, { prioridad: PRIORIDAD.lote });
    res.json(ep);
  }));
  app.post("/api/auto/:id/reintentar", envolver(async (req, res) => {
    const r = await q(`UPDATE episodios SET estado = 'procesando', error = NULL, video = video || '{"etapa":"en_cola"}'::jsonb WHERE id = $1 AND origen = 'auto' AND estado = 'error' AND video->>'etapa' = 'error' AND video ? 'key' RETURNING id`, [uuid(req.params.id)]);
    if (!r.rowCount) throw publico("No se puede reintentar: el video no está en error o ya se borró (se guardan 7 días). Súbelo de nuevo.");
    await enviar("ingesta", { episodioId: req.params.id, usuario: req.usuario }, { prioridad: PRIORIDAD.interactiva });
    res.json({ ok: true });
  }));

  // ---------- Administración ----------
  // ---------- Competencia (vista previa "Así se ve en YouTube") ----------
  app.get("/api/competencia", envolver(async (req, res) => {
    const videos = await all("SELECT id, video_id, titulo, autor, vistas, publicado, duracion FROM competencia ORDER BY coalesce(publicado, creado) DESC LIMIT 80");
    // Si hay pocos, se completa con portadas de otros episodios de Gancho.
    const propias = await all(`SELECT coalesce(p.imagen->>'mini', p.imagen->>'key') AS key, p.data->>'titulo' AS titulo, e.canal
      FROM propuestas p JOIN episodios e ON e.id = p.episodio_id
      WHERE NOT p.archivada AND p.imagen->>'estado' = 'lista' ORDER BY p.creado DESC LIMIT 24`).catch(() => []);
    res.json({ videos, propias, youtubeApi: youtubeApi() });
  }));
  // Con YOUTUBE_API_KEY: lo que sale al buscar un tema, o lo que es tendencia en México.
  app.get("/api/competencia/youtube", envolver(async (req, res) => {
    if (!youtubeApi()) throw publico("Falta YOUTUBE_API_KEY en el servidor.", 400);
    const texto = limpiar(req.query.q, 100);
    res.json({ videos: texto ? await buscarYouTube(texto) : await tendenciasYouTube() });
  }));
  app.post("/api/competencia", envolver(async (req, res) => {
    const { videos, fallidos } = await leerLinks(req.body?.links);
    if (!videos.length) throw publico(fallidos.length ? "No pude leer esos links. Pega links de videos o de canales de YouTube." : "Pega al menos un link.");
    let agregados = 0;
    for (const v of videos) {
      const r = await q(`INSERT INTO competencia (video_id, titulo, autor, vistas, publicado, duracion, creado_por) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (video_id) DO UPDATE SET titulo = excluded.titulo, vistas = coalesce(excluded.vistas, competencia.vistas), duracion = coalesce(excluded.duracion, competencia.duracion)`,
        [v.video_id, v.titulo, v.autor, v.vistas, v.publicado, v.duracion, req.usuario]);
      agregados += r.rowCount;
    }
    res.json({ agregados, fallidos });
  }));
  app.delete("/api/competencia", envolver(async (req, res) => {
    await q("DELETE FROM competencia WHERE id = $1", [uuid(req.body?.id)]);
    res.json({ ok: true });
  }));

  app.get("/api/canales", envolver(async (req, res) => {
    const cs = await repo.canales();
    res.json(req.user.rol === "admin" ? cs : cs.map(({ webhook_url, ...c }) => ({ ...c, webhook_url: webhook_url ? "configurado" : null })));
  }));
  app.put("/api/admin/canales/:id", soloAdmin, envolver(async (req, res) => {
    const id = String(req.params.id).toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 30);
    if (!id) throw publico("El código del canal solo puede tener letras, números y _.");
    const b = req.body;
    if (b.nuevo && (await repo.canal(id))) throw publico(`Ya existe un canal con el código ${id}. Usa otro.`, 409);
    const nombre = limpiar(b.nombre, 80);
    if (!nombre) throw publico("Escribe el nombre del canal.");
    const lista = (v, max, n) => (Array.isArray(v) ? v : String(v || "").split(/\r?\n|,/)).map((x) => limpiar(x, max)).filter(Boolean).slice(0, n);
    const hashtags = lista(String(b.hashtags || "").split(/[\s,]+/), 60, 6).filter((h) => /^#\S+$/.test(h));
    const umbral = b.auto_aprobar === null || b.auto_aprobar === "" || b.auto_aprobar === undefined ? null : Math.max(60, Math.min(99, Number(b.auto_aprobar) || 85));
    const webhook = limpiar(b.webhook_url, 500);
    if (webhook && !/^https:\/\/(hooks\.slack\.com|chat\.googleapis\.com|discord\.com|discordapp\.com)\//.test(webhook)) {
      throw publico("El aviso solo acepta webhooks de Slack, Google Chat o Discord.");
    }
    res.json(await one(`INSERT INTO canales (id, nombre, voz, descripcion_fija, disclaimer, hashtags_base, activo, idioma, pais, estilo_visual, ejemplos, tags_base, modelo, auto_aprobar, webhook_url)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      ON CONFLICT (id) DO UPDATE SET nombre=$2, voz=$3, descripcion_fija=$4, disclaimer=$5, hashtags_base=$6, activo=$7, idioma=$8, pais=$9,
        estilo_visual=$10, ejemplos=$11, tags_base=$12, modelo=$13, auto_aprobar=$14, webhook_url=$15 RETURNING *`,
      [id, nombre, limpiar(b.voz, 800), limpiar(b.descripcion_fija, 3000), limpiar(b.disclaimer, 1500), JSON.stringify(hashtags), b.activo !== false,
        Object.hasOwn(IDIOMAS, b.idioma || "") ? b.idioma : "es", limpiar(b.pais, 60), limpiar(b.estilo_visual, 800), JSON.stringify(lista(b.ejemplos, 120, 20)),
        JSON.stringify(lista(b.tags_base, 60, 15)), Object.hasOwn(nb.MODELOS, b.modelo || "") ? b.modelo : "pro", umbral, webhook || null]));
  }));
  app.post("/api/admin/canales/sugerir", soloAdmin, envolver(async (req, res) => {
    const ejemplos = String(req.body.ejemplos || "").split(/\r?\n/).map((x) => limpiar(x, 120)).filter(Boolean).slice(0, 20);
    if (ejemplos.length < 3) throw publico("Pega al menos 3 títulos que le hayan funcionado al canal.");
    const r = await ia.sugerirCanal({ nombre: limpiar(req.body.nombre, 80), idioma: Object.hasOwn(IDIOMAS, req.body.idioma || "") ? req.body.idioma : "es", pais: limpiar(req.body.pais, 60), ejemplos });
    await repo.sumarUso(req.usuario, "textos");
    res.json(r);
  }));
  app.post("/api/admin/canales/:id/probar-aviso", soloAdmin, envolver(async (req, res) => {
    const c = await repo.canal(req.params.id);
    if (!c?.webhook_url) throw publico("Guarda primero el webhook del canal.");
    const { notificar } = await import("./notificar.js");
    await notificar(c, `👋 Prueba de avisos de Gancho para "${c.nombre}".`);
    res.json({ ok: true });
  }));
  app.post("/api/admin/canales/:id/logo", soloAdmin, subir.single("logo"), envolver(async (req, res) => {
    const c = await repo.canal(req.params.id);
    if (!c) throw publico("Ese canal no existe.", 404);
    if (!req.file || tipoImagen(req.file.buffer) !== "png") throw publico("El logo debe ser PNG con fondo transparente.");
    const key = await storage.guardar("logos", req.file.buffer, "png");
    if (c.logo_key) await storage.borrar(c.logo_key);
    res.json(await one("UPDATE canales SET logo_key = $2 WHERE id = $1 RETURNING *", [c.id, key]));
  }));
  app.get("/api/admin/usuarios", soloAdmin, envolver(async (req, res) => {
    res.json(await all("SELECT id, usuario, rol, activo, creado FROM usuarios ORDER BY creado"));
  }));
  app.post("/api/admin/usuarios", soloAdmin, envolver(async (req, res) => {
    const usuario = normalizarUsuario(req.body.usuario);
    if (!/^[a-z0-9._-]{2,40}$/.test(usuario)) throw publico("El usuario solo puede tener letras, números, punto o guion.");
    const err = validarClave(req.body.clave);
    if (err) throw publico(err);
    const rol = req.body.rol === "admin" ? "admin" : "editor";
    const u = await one("INSERT INTO usuarios (usuario, clave_hash, rol) VALUES ($1,$2,$3) ON CONFLICT (usuario) DO NOTHING RETURNING id, usuario, rol, activo",
      [usuario, hashClave(req.body.clave), rol]);
    if (!u) throw publico("Ese usuario ya existe.", 409);
    res.json(u);
  }));
  app.patch("/api/admin/usuarios/:id", soloAdmin, envolver(async (req, res) => {
    const id = uuid(req.params.id);
    if (id === req.user.id && (req.body.activo === false || req.body.rol === "editor")) throw publico("No puedes quitarte el acceso de administrador a ti mismo.");
    const sets = [], vals = [id];
    if (typeof req.body.activo === "boolean") { vals.push(req.body.activo); sets.push(`activo = $${vals.length}`); }
    if (["admin", "editor"].includes(req.body.rol)) { vals.push(req.body.rol); sets.push(`rol = $${vals.length}`); }
    if (req.body.clave) { const err = validarClave(req.body.clave); if (err) throw publico(err); vals.push(hashClave(req.body.clave)); sets.push(`clave_hash = $${vals.length}`); }
    if (!sets.length) throw publico("Nada que cambiar.");
    const u = await one(`UPDATE usuarios SET ${sets.join(", ")} WHERE id = $1 RETURNING id, usuario, rol, activo`, vals);
    olvidarUsuario(id);
    res.json(u);
  }));
  app.get("/api/admin/uso", soloAdmin, envolver(async (req, res) => {
    const dias = await all(`SELECT dia::text, usuario, imagenes, textos FROM uso WHERE dia > current_date - 14 ORDER BY dia DESC, imagenes DESC`);
    const estados = await all(`SELECT imagen->>'estado' AS estado, count(*)::int AS n FROM propuestas WHERE NOT archivada AND creado > now() - interval '2 days' GROUP BY 1`);
    let creditos = null;
    try { creditos = await nb.creditos(); } catch {}
    const porProveedor = await all(`SELECT imagen->>'proveedor' AS proveedor, imagen->>'estado' AS estado, count(*)::int AS n
      FROM propuestas WHERE creado > now() - interval '1 day' AND imagen ? 'proveedor' GROUP BY 1, 2`);
    res.json({ dias, estados, cola: await estadoCola(), creditos, creditosPorImagen: config.creditsPerImage,
      proveedores: ordenProveedores().map((p) => ({ id: p, nombre: PROVEEDORES[p].nombre })), porProveedor });
  }));

  // ---------- Errores ----------
  app.use((req, res) => res.status(404).json({ error: "No encontrado." }));
  app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
      const m = err.code === "LIMIT_FILE_SIZE" ? "Cada foto debe pesar menos de 8 MB." : err.code === "LIMIT_FILE_COUNT" ? "Máximo 8 fotos a la vez." : "No se pudieron subir las fotos.";
      return res.status(400).json({ error: m });
    }
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Datos inválidos." });
    if (err.type === "entity.too.large") return res.status(413).json({ error: "La lista es demasiado grande. Divide el lote." });
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Algo falló en el servidor. Intenta de nuevo." });
  });
  return app;
}

// ---------- utilidades ----------
// Borrar: solo administradores o quien lo creó.
function puedeBorrar(req, creadoPor) {
  if (req.user.rol !== "admin" && creadoPor !== req.usuario) throw publico("Solo quien lo creó o un administrador puede borrarlo.", 403);
}
function envolver(fn) {
  return (req, res, next) => fn(req, res).catch((e) => {
    if (e.publico) return res.status(e.status || 400).json({ error: e.message });
    next(e);
  });
}
function publico(msg, status = 400) { return Object.assign(new Error(msg), { publico: true, status }); }
function limpiar(s, max = 2000) { return String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max); }
function uuid(id) { if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id))) throw publico("No encontrado.", 404); return id; }
function adjunto(nombre, ext) {
  const limpio = archivoSeguro(nombre);
  const ascii = limpio.replace(/[^\x20-\x7e]/g, "").trim() || "archivo";
  return `attachment; filename="${ascii}.${ext}"; filename*=UTF-8''${encodeURIComponent(limpio)}.${ext}`;
}
// Evita que Excel/Sheets interprete un texto como fórmula.
const celda = (c) => { const t = String(c ?? ""); return `"${(/^[=+\-@\t\r]/.test(t) ? `'${t}` : t).replace(/"/g, '""')}"`; };
function archivoSeguro(s) { return String(s || "portada").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "portada"; }

// Reserva atómica del cupo diario: dos lotes simultáneos no pueden pasarse del límite.
async function reservarCupo(usuario, n) {
  if (config.mockImages || n <= 0) return;
  const L = config.limits;
  if (n > L.userDailyImages) throw publico(`Esto son ${n} portadas y tu límite diario es ${L.userDailyImages}.`, 429);
  const r = await one(`INSERT INTO uso (usuario, imagenes) VALUES ($1, $2)
      ON CONFLICT (dia, usuario) DO UPDATE SET imagenes = uso.imagenes + EXCLUDED.imagenes WHERE uso.imagenes + EXCLUDED.imagenes <= $3
      RETURNING imagenes`, [usuario, n, L.userDailyImages]);
  if (!r) { const u = await repo.usoHoy(usuario); throw publico(`Esto pasa tu límite de ${L.userDailyImages} portadas por día (llevas ${u.imagenes}).`, 429); }
  const org = await one("SELECT coalesce(sum(imagenes),0)::int AS n FROM uso WHERE dia = current_date");
  if (org.n > L.orgDailyImages) {
    await devolverCupo(usuario, n);
    throw publico(`Esto pasa el límite del equipo de ${L.orgDailyImages} portadas por día.`, 429);
  }
}
async function devolverCupo(usuario, n) {
  if (config.mockImages || n <= 0) return;
  await q("UPDATE uso SET imagenes = greatest(0, imagenes - $2) WHERE dia = current_date AND usuario = $1", [usuario, n]);
}
// Solo revisa (no reserva): para avisar antes de subir un video pesado.
async function hayCupo(usuario, n) {
  if (config.mockImages) return;
  const u = await repo.usoHoy(usuario);
  if (u.imagenes + n > config.limits.userDailyImages) throw publico(`Ya llegaste a tu límite de ${config.limits.userDailyImages} portadas por día.`, 429);
}

async function borrarEpisodios(where, params) {
  const keys = await all(`SELECT k FROM (
      SELECT p.imagen->>'key' AS k FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT p.imagen->>'mini' FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT v.imagen->>'key' FROM versiones v JOIN propuestas p ON p.id = v.propuesta_id JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT v.imagen->>'mini' FROM versiones v JOIN propuestas p ON p.id = v.propuesta_id JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT e.video->>'key' FROM episodios e WHERE ${where}
      UNION ALL SELECT jsonb_array_elements_text(coalesce(e.video->'cuadros', '[]'::jsonb)) FROM episodios e WHERE ${where}
    ) x WHERE k IS NOT NULL`, params);
  await q(`DELETE FROM episodios e WHERE ${where}`, params);
  for (const { k } of keys) await storage.borrar(k);
}
