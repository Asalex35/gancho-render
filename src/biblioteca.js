// Biblioteca de rostros por actor: cada actor junta sus mejores caras (de sus fotos y de cada episodio).
// Sirve para (1) reconocer al actor en un video nuevo, (2) dar mejores referencias a Nano Banana
// y (3) medir qué tanto se parece la portada al actor real.
import sharp from "sharp";
import { q, one, all } from "./db.js";
import * as storage from "./storage.js";
import * as caras from "./caras.js";

// Perfil del actor: sus fotos oficiales (nunca se borran) + las mejores caras sacadas de los episodios.
const MAX_POR_ACTOR = Number(process.env.CARAS_POR_ACTOR || 24); // caras de episodio que se conservan
const POR_ANGULO = 4;    // mínimo que se cuida de cada ángulo (frente, 3/4, perfil) para tener variedad
const GEMELA = 0.93;     // casi la misma imagen: solo se queda la mejor
const PERTENECE = 0.42;  // una cara nueva debe parecerse al perfil para entrar (no ensuciarlo con otra persona)
export const RECONOCER = 0.45; // similitud mínima para decir "es este actor"

// Cara principal de una foto subida a la biblioteca (una por foto).
export async function procesarFoto(actorId, fotoKey) {
  if (await one("SELECT 1 FROM actor_caras WHERE actor_id = $1 AND foto_key = $2", [actorId, fotoKey])) return;
  let buf = await storage.leer(fotoKey);
  // Foto oficial del actor: filtros suaves (una foto retocada o en 3/4 sigue siendo buena referencia).
  const opc = { minArea: 0.0008, minScore: 0.6, maxGiro: 0.75, minNitidez: 2 };
  let c = (await caras.analizarCuadro(buf, opc)).sort((a, b) => b.cara.area - a.cara.area)[0];
  // Cara chica en una foto grande (cuerpo completo, grupo): se busca de nuevo con zoom en partes de la foto.
  if (!c) {
    const { width: W, height: H } = await sharp(buf).metadata();
    const t = 0.6, zonas = [[0.2, 0.05], [0, 0], [0.4, 0], [0, 0.4], [0.4, 0.4], [0.2, 0.2]];
    for (const [x, y] of zonas) {
      const parte = await sharp(buf).extract({ left: Math.round(W * x), top: Math.round(H * y), width: Math.round(W * t), height: Math.round(H * t) })
        .resize({ width: 1600, height: 1600, fit: "inside" }).jpeg({ quality: 92 }).toBuffer();
      c = (await caras.analizarCuadro(parte, opc)).sort((a, b) => b.cara.area - a.cara.area)[0];
      if (c) { buf = parte; break; }
    }
  }
  if (!c) { console.warn(`Biblioteca: no encontré una cara clara en la foto ${fotoKey} (actor ${actorId}). Sube una foto de frente.`); return false; }
  const { rostro } = await caras.recortes(buf, c.cara);
  const key = await storage.guardar("rostros", rostro, "jpg");
  await q(`INSERT INTO actor_caras (actor_id, key, huella, calidad, giro, origen, foto_key) VALUES ($1,$2,$3,$4,$5,'foto',$6)`,
    [actorId, key, c.huella, c.calidad + 5, c.giro, fotoKey]); // las fotos oficiales pesan un poco más
}

// Al arrancar: procesa fotos de actores que todavía no tienen su huella (p. ej. subidas antes de esta versión).
export async function ponerAlDia() {
  const actores = await all("SELECT id, fotos FROM actores");
  let n = 0;
  for (const a of actores) for (const f of a.fotos || []) {
    try { if (!(await one("SELECT 1 FROM actor_caras WHERE actor_id = $1 AND foto_key = $2", [a.id, f])) && (await procesarFoto(a.id, f)) !== false) n++; }
    catch (e) { console.warn("Biblioteca:", e.message); }
  }
  if (n) console.log(`Biblioteca de rostros: ${n} fotos procesadas`);
}

// ¿De qué actor es esta cara? Compara contra las mejores caras de cada actor.
export async function identificar(huella) {
  const filas = await all(`SELECT ac.actor_id, a.nombre, ac.huella FROM actor_caras ac JOIN actores a ON a.id = ac.actor_id
    WHERE ac.id IN (SELECT id FROM (SELECT id, row_number() OVER (PARTITION BY actor_id ORDER BY calidad DESC) AS r FROM actor_caras) x WHERE r <= 12)`);
  const mejor = {};
  for (const f of filas) {
    const s = caras.similitud(huella, f.huella);
    if (!mejor[f.actor_id] || s > mejor[f.actor_id].sim) mejor[f.actor_id] = { actorId: f.actor_id, nombre: f.nombre, sim: s };
  }
  const orden = Object.values(mejor).sort((a, b) => b.sim - a.sim);
  const [a, b] = orden;
  if (a && a.sim >= RECONOCER && (!b || a.sim - b.sim >= 0.05)) return a;
  return null;
}

// Guarda las mejores caras de un episodio en la biblioteca del actor (se queda con las 40 mejores).
// Mejora el perfil del actor con las caras de un episodio: agrega las buenas, reemplaza casi-duplicadas peores,
// ignora caras de otra persona y poda las que sobran cuidando que queden caras de frente, 3/4 y perfil.
export async function agregarDeEpisodio(actorId, elegidas, episodioId) {
  const actuales = await all("SELECT id, key, huella, calidad, giro, origen FROM actor_caras WHERE actor_id = $1 ORDER BY calidad DESC", [actorId]);
  const centro = actuales.length ? caras.promedio(actuales.slice(0, 12).map((f) => f.huella)) : null;
  const r = { agregadas: 0, reemplazadas: 0, ignoradas: 0, borradas: 0 };
  for (const c of elegidas) {
    if (!c.rostro || !c.huella) continue;
    if (centro && caras.similitud(centro, c.huella) < PERTENECE) { r.ignoradas++; continue; }
    const gemela = actuales.find((f) => caras.similitud(f.huella, c.huella) > GEMELA);
    if (gemela && (gemela.origen === "foto" || gemela.calidad >= c.calidad)) { r.ignoradas++; continue; }
    if (gemela) {
      await q("DELETE FROM actor_caras WHERE id = $1", [gemela.id]); await storage.borrar(gemela.key);
      actuales.splice(actuales.indexOf(gemela), 1); r.reemplazadas++;
    }
    const key = await storage.guardar("rostros", c.rostro, "jpg");
    const fila = await one(`INSERT INTO actor_caras (actor_id, key, huella, calidad, giro, origen, episodio_id) VALUES ($1,$2,$3,$4,$5,'episodio',$6) RETURNING id, key, huella, calidad, giro, origen`,
      [actorId, key, c.huella, c.calidad, c.giro, episodioId]);
    actuales.push(fila); r.agregadas++;
  }
  // Poda: se quedan las mejores, pero con variedad de ángulos (no 24 caras de frente iguales).
  const deEpisodio = actuales.filter((f) => f.origen === "episodio").sort((a, b) => b.calidad - a.calidad);
  if (deEpisodio.length > MAX_POR_ACTOR) {
    const angulo = (g) => (g < 0.15 ? "frente" : g <= 0.45 ? "tres" : "perfil");
    const quedan = new Set();
    const minimo = Math.min(POR_ANGULO, Math.floor(MAX_POR_ACTOR / 3)); // la variedad nunca pasa del límite
    for (const a of ["frente", "tres", "perfil"]) deEpisodio.filter((f) => angulo(f.giro) === a).slice(0, minimo).forEach((f) => quedan.add(f.id));
    for (const f of deEpisodio) { if (quedan.size >= MAX_POR_ACTOR) break; quedan.add(f.id); }
    for (const f of deEpisodio.filter((x) => !quedan.has(x.id))) {
      await q("DELETE FROM actor_caras WHERE id = $1", [f.id]); await storage.borrar(f.key); r.borradas++;
    }
  }
  if (r.agregadas || r.borradas) console.log(`Biblioteca: actor ${String(actorId).slice(0, 8)} +${r.agregadas} caras, ${r.reemplazadas} mejoradas, ${r.borradas} borradas, ${r.ignoradas} ignoradas`);
  return r;
}

// Actor nuevo que Gancho no conoce: se crea con el nombre del personaje para que el equipo lo renombre.
export async function crearActorAuto(nombre, usuario) {
  return one("INSERT INTO actores (nombre, fotos, creado_por, auto) VALUES ($1, '[]', $2, true) RETURNING id, nombre", [nombre.slice(0, 80), usuario]);
}

// Mejores referencias del actor: variedad de ángulos, las de más calidad primero.
export async function referencias(actorId, n = 2) {
  const filas = await all("SELECT key, giro, calidad FROM actor_caras WHERE actor_id = $1 ORDER BY calidad DESC LIMIT 20", [actorId]);
  const out = [];
  const frente = filas.find((f) => f.giro < 0.15), tres = filas.find((f) => f.giro >= 0.15 && f.giro <= 0.45);
  for (const f of [frente, tres, ...filas]) { if (f && !out.includes(f.key)) out.push(f.key); if (out.length >= n) break; }
  return out;
}

// Huella promedio del actor (para medir el parecido de la portada).
export async function huellaDe(actorId) {
  const filas = await all("SELECT huella FROM actor_caras WHERE actor_id = $1 ORDER BY calidad DESC LIMIT 12", [actorId]);
  return filas.length ? caras.promedio(filas.map((f) => f.huella)) : null;
}
