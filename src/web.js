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
import { tipoImagen, normalizarFoto, portadaFinal } from "./imagenes.js";
import { interpretar, PLANTILLA, normal } from "./lotes.js";
import {
  verificar, crearSesion, cerrarSesion, requiereSesion, soloAdmin, antiCsrf, usuarioDe,
  hashClave, validarClave, normalizarUsuario, olvidarUsuario,
} from "./auth.js";

const PUBLIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
const ROLES = ["transgresor", "victima", "testigo", "villano", "otro"];

export function crearApp() {
  const app = express();
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

  // ---------- Encabezados de seguridad ----------
  app.use((req, res, next) => {
    res.set({
      "Content-Security-Policy": [
        "default-src 'self'", "img-src 'self' data: blob: https:", "style-src 'self' https://fonts.googleapis.com",
        "font-src https://fonts.gstatic.com", "script-src 'self'", "connect-src 'self'",
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

  app.get("/salud", (req, res) => res.json({ ok: true }));

  // ---------- Fotos firmadas para Nano Banana (modo local) ----------
  app.get("/pub/:carpeta/:archivo", (req, res) => {
    const key = `${req.params.carpeta}/${req.params.archivo}`;
    if (!storage.verificarEnlace(key, req.query.exp, req.query.sig)) return res.sendStatus(404);
    res.set("Cache-Control", "no-store").sendFile(storage.rutaLocal(key), (e) => e && !res.headersSent && res.sendStatus(404));
  });
  app.post(`/api/nb-callback/${config.callbackSecret}`, (req, res) => res.json({ ok: true }));

  // ---------- Login ----------
  const limiteLogin = rateLimit({ windowMs: 15 * 60e3, limit: 10, standardHeaders: true, legacyHeaders: false, message: { error: "Demasiados intentos. Espera 15 minutos." } });
  app.get("/login", async (req, res) => ((await usuarioDe(req)) ? res.redirect("/") : res.sendFile(path.join(PUBLIC, "login.html"))));
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
      canales: (await repo.canales()).filter((c) => c.activo).map((c) => ({ id: c.id, nombre: c.nombre, logo: c.logo_key })),
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
    res.json(await all("SELECT id, nombre, fotos, creado_por, creado FROM actores ORDER BY lower(nombre)"));
  }));
  app.post("/api/actores", subir.array("fotos", 8), envolver(async (req, res) => {
    const nombre = limpiar(req.body.nombre, 80);
    if (!nombre) throw publico("Escribe el nombre del actor.");
    if (!req.files?.length) throw publico("Sube al menos una foto.");
    const fotos = await guardarFotos(req.files);
    res.json(await one("INSERT INTO actores (nombre, fotos, creado_por) VALUES ($1, $2, $3) RETURNING *", [nombre, JSON.stringify(fotos), req.usuario]));
  }));
  app.post("/api/actores/:id/fotos", subir.array("fotos", 8), envolver(async (req, res) => {
    const fotos = await guardarFotos(req.files);
    const a = await one("UPDATE actores SET fotos = fotos || $2::jsonb WHERE id = $1 RETURNING *", [uuid(req.params.id), JSON.stringify(fotos)]);
    if (!a) throw publico("Ese actor no existe.", 404);
    res.json(a);
  }));
  app.patch("/api/actores/:id", envolver(async (req, res) => {
    const a = await one("SELECT * FROM actores WHERE id = $1", [uuid(req.params.id)]);
    if (!a) throw publico("Ese actor no existe.", 404);
    const nombre = limpiar(req.body.nombre, 80) || a.nombre;
    let fotos = a.fotos;
    if (Array.isArray(req.body.quitarFotos)) {
      const quitar = req.body.quitarFotos.filter((k) => fotos.includes(k));
      fotos = fotos.filter((k) => !quitar.includes(k));
      for (const k of quitar) await storage.borrar(k);
    }
    res.json(await one("UPDATE actores SET nombre = $2, fotos = $3 WHERE id = $1 RETURNING *", [a.id, nombre, JSON.stringify(fotos)]));
  }));
  app.delete("/api/actores/:id", envolver(async (req, res) => {
    const a = await one("DELETE FROM actores WHERE id = $1 RETURNING fotos", [uuid(req.params.id)]);
    for (const k of a?.fotos || []) await storage.borrar(k);
    res.json({ ok: true });
  }));

  // ---------- Episodios ----------
  async function armarCast(castIn) {
    if (!Array.isArray(castIn)) return [];
    const ids = castIn.map((c) => c.actorId).filter((id) => /^[0-9a-f-]{36}$/.test(id || ""));
    const actores = ids.length ? await all("SELECT id, nombre, fotos FROM actores WHERE id = ANY($1)", [ids]) : [];
    return castIn.slice(0, 8).map((c) => {
      const actor = actores.find((a) => a.id === c.actorId);
      const personaje = limpiar(c.personaje, 60);
      if (!personaje) return null;
      return { actorId: actor?.id || null, actorNombre: actor?.nombre || null, personaje, edad: limpiar(c.edad, 20),
        rol: ROLES.includes(c.rol) ? c.rol : "otro", vestuario: limpiar(c.vestuario, 200), tieneFotos: Boolean(actor?.fotos?.length) };
    }).filter(Boolean);
  }
  async function datosEpisodio(b) {
    const canal = (await repo.canal(b.canal)) ? b.canal : (await repo.canales())[0].id;
    const brief = {
      sinopsis: limpiar(b.sinopsis, 4000), giro: limpiar(b.giro, 600), momento: limpiar(b.momento, 600),
      desenlace: limpiar(b.desenlace, 600), escenario: limpiar(b.escenario, 200), notas: limpiar(b.notas, 600),
    };
    if (!brief.sinopsis) throw publico("Falta la sinopsis.");
    return { canal, modelo: nb.MODELOS[b.modelo] ? b.modelo : "nb2", titulo: limpiar(b.titulo, 120) || brief.sinopsis.slice(0, 60), brief, cast: await armarCast(b.cast) };
  }

  app.get("/api/episodios", envolver(async (req, res) => {
    const filas = await all(`
      SELECT e.id, e.titulo, e.canal, e.estado, e.actualizado, e.creado_por, e.lote_id, e.elegida,
        (SELECT coalesce(p.imagen->>'mini', p.imagen->>'key') FROM propuestas p WHERE p.episodio_id = e.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista'
         ORDER BY (p.id = e.elegida) DESC, p.slot LIMIT 1) AS portada
      FROM episodios e WHERE e.lote_id IS NULL ORDER BY e.actualizado DESC LIMIT 60`);
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
    await borrarEpisodios("e.id = $1", [uuid(req.params.id)]);
    res.json({ ok: true });
  }));

  async function generar(ep, usuario, prioridad) {
    const r = await q(`UPDATE episodios SET estado = 'en_cola', error = NULL, actualizado = now()
                       WHERE id = $1 AND estado NOT IN ('en_cola', 'pensando') RETURNING id`, [ep]);
    if (!r.rowCount) return false;
    await enviar("propuestas", { episodioId: ep, usuario, prioridad }, { prioridad });
    return true;
  }
  app.post("/api/episodios/:id/generar", envolver(async (req, res) => {
    await verificarLimite(req.usuario, 3);
    if (!(await generar(uuid(req.params.id), req.usuario, PRIORIDAD.interactiva))) throw publico("Ya se está generando.", 409);
    res.status(202).json({ ok: true });
  }));

  // Portada final 1280x720 con logo, lista para YouTube
  app.get("/api/episodios/:id/portada.jpg", envolver(async (req, res) => {
    const ep = await repo.episodio(uuid(req.params.id));
    const p = ep?.propuestas.find((x) => x.id === (req.query.propuesta || ep.elegida));
    if (!p?.imagen?.key) throw publico("No hay portada lista.", 404);
    const canal = await repo.canal(ep.canal);
    const buf = await portadaFinal(p.imagen.key, req.query.logo === "0" ? null : canal.logo_key);
    res.set({ "Content-Type": "image/jpeg", "Content-Disposition": `attachment; filename="${archivoSeguro(ep.titulo)}.jpg"` }).send(buf);
  }));

  // ---------- Propuestas ----------
  async function propuestaConEpisodio(id) {
    const p = await one(`SELECT p.*, e.canal, e.elegida, e.paquete FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE p.id = $1`, [uuid(id)]);
    if (!p) throw publico("Esa propuesta no existe.", 404);
    return p;
  }
  app.post("/api/propuestas/:id/rehacer", envolver(async (req, res) => {
    const objetivo = ["portada", "titulo", "ambos"].includes(req.body.objetivo) ? req.body.objetivo : "ambos";
    const razones = (Array.isArray(req.body.razones) ? req.body.razones : []).map((r) => limpiar(r, 80)).filter(Boolean).slice(0, 8);
    const comentario = limpiar(req.body.comentario, 500);
    if (!razones.length && !comentario) throw publico("Dinos por qué no te gustó para poder mejorarla.");
    if (objetivo !== "titulo") await verificarLimite(req.usuario, 1);
    const p = await propuestaConEpisodio(req.params.id);
    const r = await q("UPDATE propuestas SET rehaciendo = $2, error_rehacer = NULL WHERE id = $1 AND rehaciendo IS NULL", [p.id, objetivo]);
    if (!r.rowCount) throw publico("Ya se está rehaciendo.", 409);
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
    await tx(async (c) => {
      const { rows: [v] } = await c.query("DELETE FROM versiones WHERE id = $1 AND propuesta_id = $2 RETURNING *", [uuid(req.body.versionId), p.id]);
      if (!v) throw publico("Esa versión no existe.", 404);
      await c.query("INSERT INTO versiones (propuesta_id, data, imagen, evaluacion) VALUES ($1,$2,$3,$4)", [p.id, p.data, p.imagen, p.evaluacion]);
      await c.query("UPDATE propuestas SET data = $2, imagen = $3, evaluacion = $4, version = version + 1, editado = false WHERE id = $1", [p.id, v.data, v.imagen, v.evaluacion]);
      await c.query("UPDATE episodios SET elegida = NULL, paquete = NULL WHERE id = $1 AND elegida = $2", [p.episodio_id, p.id]);
      await c.query("UPDATE episodios SET actualizado = now() WHERE id = $1", [p.episodio_id]);
    });
    res.json({ ok: true });
  }));
  app.patch("/api/propuestas/:id", envolver(async (req, res) => {
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
    const r = await q("UPDATE episodios SET eligiendo = true, actualizado = now() WHERE id = $1 AND NOT eligiendo", [p.episodio_id]);
    if (!r.rowCount) throw publico("Ya se está escribiendo el paquete.", 409);
    await enviar("paquete", { episodioId: p.episodio_id, propuestaId: p.id, usuario: req.usuario }, { prioridad: PRIORIDAD.interactiva });
    res.status(202).json({ ok: true });
  }));
  app.post("/api/propuestas/:id/reintentar", envolver(async (req, res) => {
    await verificarLimite(req.usuario, 1);
    const p = await propuestaConEpisodio(req.params.id);
    await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"en_cola","error":null}'::jsonb WHERE id = $1`, [p.id]);
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
    const modelo = nb.MODELOS[req.body.modelo] ? req.body.modelo : "nb2";
    const { filas, error } = await interpretar(req.body.texto, canales);
    if (error) throw publico(error);
    const validas = filas.filter((f) => !f.errores.length);
    if (!validas.length) throw publico("No hay filas válidas.");
    if (validas.length > config.limits.maxEpisodesPerBatch) throw publico(`Máximo ${config.limits.maxEpisodesPerBatch} episodios por lote.`);
    await verificarLimite(req.usuario, validas.length * 3);

    const lote = await tx(async (c) => {
      const { rows: [l] } = await c.query("INSERT INTO lotes (nombre, canal, modelo, auto_elegir, creado_por) VALUES ($1,$2,$3,$4,$5) RETURNING *",
        [limpiar(req.body.nombre, 120) || `Lote ${new Date().toLocaleDateString("es-MX")}`, canal, modelo, Boolean(req.body.autoElegir), req.usuario]);
      l.episodios = [];
      for (const [i, f] of validas.entries()) {
        const brief = { ...f.brief, actoresMapa: Object.fromEntries(f.reparto.filter((r) => r.actorId).map((r) => [normal(r.personaje), r.actorId])) };
        const { rows: [e] } = await c.query(`INSERT INTO episodios (lote_id, orden, titulo, canal, modelo, brief, estado, creado_por)
            VALUES ($1,$2,$3,$4,$5,$6,'en_cola',$7) RETURNING id`, [l.id, i, f.nombre, f.canal || canal, modelo, brief, req.usuario]);
        l.episodios.push(e.id);
      }
      return l;
    });
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
        (SELECT p.id FROM propuestas p WHERE p.episodio_id = e.id AND NOT p.archivada AND p.imagen->>'estado' = 'lista'
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
    await verificarLimite(req.usuario, eps.length * 3 + imgs.length);
    for (const e of eps) await generar(e.id, req.usuario, PRIORIDAD.lote);
    for (const p of imgs) {
      await q(`UPDATE propuestas SET imagen = imagen || '{"estado":"en_cola","error":null}'::jsonb WHERE id = $1`, [p.id]);
      await enviar("imagen", { propuestaId: p.id, usuario: req.usuario, prioridad: PRIORIDAD.lote }, { prioridad: PRIORIDAD.lote });
    }
    res.json({ episodios: eps.length, imagenes: imgs.length });
  }));
  app.delete("/api/lotes/:id", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    await borrarEpisodios("e.lote_id = $1", [id]);
    await q("DELETE FROM lotes WHERE id = $1", [id]);
    res.json({ ok: true });
  }));

  // ZIP con portadas finales + CSV con títulos, descripciones y tags
  app.get("/api/lotes/:id/exportar.zip", envolver(async (req, res) => {
    const id = uuid(req.params.id);
    const lote = await one("SELECT l.*, c.logo_key FROM lotes l JOIN canales c ON c.id = l.canal WHERE l.id = $1", [id]);
    if (!lote) throw publico("Ese lote no existe.", 404);
    const eps = await all(`SELECT e.*, p.imagen->>'key' AS key, p.data->>'titulo' AS titulo_yt, c.logo_key AS logo
      FROM episodios e JOIN propuestas p ON p.id = e.elegida JOIN canales c ON c.id = e.canal
      WHERE e.lote_id = $1 AND e.paquete IS NOT NULL ORDER BY e.orden`, [id]);
    if (!eps.length) throw publico("Todavía no hay episodios elegidos en este lote.");
    res.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${archivoSeguro(lote.nombre)}.zip"` });
    const zip = new ZipArchive({ zlib: { level: 1 } });
    zip.on("error", (e) => { console.error(e); res.destroy(e); });
    zip.pipe(res);
    const filas = [["orden", "archivo", "nombre_interno", "titulo", "titulo_ab_1", "titulo_ab_2", "descripcion", "tags", "hashtags"]];
    for (const e of eps) {
      const archivo = `${String(e.orden + 1).padStart(3, "0")} - ${archivoSeguro(e.titulo)}.jpg`;
      zip.append(await portadaFinal(e.key, e.logo), { name: `portadas/${archivo}` });
      const k = e.paquete;
      filas.push([e.orden + 1, archivo, e.titulo, e.titulo_yt, k.titulos_alternos?.[0] || "", k.titulos_alternos?.[1] || "", k.descripcion, k.tags.join(", "), k.hashtags.join(" ")]);
    }
    const csv = filas.map((r) => r.map((c) => `"${String(c ?? "").replace(/"/g, '""')}"`).join(",")).join("\r\n");
    zip.append(`﻿${csv}`, { name: "titulos-descripciones-tags.csv" });
    await zip.finalize();
  }));

  // ---------- Administración ----------
  app.get("/api/canales", envolver(async (req, res) => res.json(await repo.canales())));
  app.put("/api/admin/canales/:id", soloAdmin, envolver(async (req, res) => {
    const id = String(req.params.id).toUpperCase().replace(/[^A-Z0-9_]/g, "").slice(0, 30);
    if (!id) throw publico("El código del canal solo puede tener letras, números y _.");
    const b = req.body;
    const nombre = limpiar(b.nombre, 80);
    if (!nombre) throw publico("Escribe el nombre del canal.");
    const hashtags = String(b.hashtags || "").split(/[\s,]+/).filter((h) => /^#\S+$/.test(h)).slice(0, 6);
    res.json(await one(`INSERT INTO canales (id, nombre, voz, descripcion_fija, disclaimer, hashtags_base, activo) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (id) DO UPDATE SET nombre=$2, voz=$3, descripcion_fija=$4, disclaimer=$5, hashtags_base=$6, activo=$7 RETURNING *`,
      [id, nombre, limpiar(b.voz, 600), limpiar(b.descripcion_fija, 3000), limpiar(b.disclaimer, 1500), JSON.stringify(hashtags), b.activo !== false]));
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
    res.json({ dias, estados, cola: await estadoCola(), creditos, creditosPorImagen: config.creditsPerImage });
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
function envolver(fn) {
  return (req, res, next) => fn(req, res).catch((e) => {
    if (e.publico) return res.status(e.status || 400).json({ error: e.message });
    next(e);
  });
}
function publico(msg, status = 400) { return Object.assign(new Error(msg), { publico: true, status }); }
function limpiar(s, max = 2000) { return String(s ?? "").replace(/[\u0000-\u0008\u000b-\u001f]/g, "").trim().slice(0, max); }
function uuid(id) { if (!/^[0-9a-f-]{36}$/i.test(String(id))) throw publico("No encontrado.", 404); return id; }
function archivoSeguro(s) { return String(s || "portada").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N} _-]/gu, "").trim().slice(0, 60) || "portada"; }

async function verificarLimite(usuario, n) {
  const uso = await repo.usoHoy(usuario);
  if (uso.imagenes + n > config.limits.userDailyImages) throw publico(`Esto pasa tu límite de ${config.limits.userDailyImages} portadas por día (llevas ${uso.imagenes}).`, 429);
  if (uso.org + n > config.limits.orgDailyImages) throw publico(`Esto pasa el límite del equipo de ${config.limits.orgDailyImages} portadas por día.`, 429);
}

async function borrarEpisodios(where, params) {
  const keys = await all(`SELECT k FROM (
      SELECT p.imagen->>'key' AS k FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT p.imagen->>'mini' FROM propuestas p JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT v.imagen->>'key' FROM versiones v JOIN propuestas p ON p.id = v.propuesta_id JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
      UNION ALL SELECT v.imagen->>'mini' FROM versiones v JOIN propuestas p ON p.id = v.propuesta_id JOIN episodios e ON e.id = p.episodio_id WHERE ${where}
    ) x WHERE k IS NOT NULL`, params);
  await q(`DELETE FROM episodios e WHERE ${where}`, params);
  for (const { k } of keys) await storage.borrar(k);
}
