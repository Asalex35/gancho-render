// Biblioteca de rostros por actor: cada actor junta sus mejores caras (de sus fotos y de cada episodio).
// Sirve para (1) reconocer al actor en un video nuevo, (2) dar mejores referencias a Nano Banana
// y (3) medir qué tanto se parece la portada al actor real.
import { q, one, all } from "./db.js";
import * as storage from "./storage.js";
import * as caras from "./caras.js";

const MAX_POR_ACTOR = 40;
export const RECONOCER = 0.45; // similitud mínima para decir "es este actor"

// Cara principal de una foto subida a la biblioteca (una por foto).
export async function procesarFoto(actorId, fotoKey) {
  if (await one("SELECT 1 FROM actor_caras WHERE actor_id = $1 AND foto_key = $2", [actorId, fotoKey])) return;
  const buf = await storage.leer(fotoKey);
  const utiles = await caras.analizarCuadro(buf, { minArea: 0.004 });
  const c = utiles.sort((a, b) => b.cara.area - a.cara.area)[0];
  if (!c) return;
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
    try { if (!(await one("SELECT 1 FROM actor_caras WHERE actor_id = $1 AND foto_key = $2", [a.id, f]))) { await procesarFoto(a.id, f); n++; } }
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
export async function agregarDeEpisodio(actorId, elegidas, episodioId) {
  for (const c of elegidas) {
    const key = await storage.guardar("rostros", c.rostro, "jpg");
    await q(`INSERT INTO actor_caras (actor_id, key, huella, calidad, giro, origen, episodio_id) VALUES ($1,$2,$3,$4,$5,'episodio',$6)`,
      [actorId, key, c.huella, c.calidad, c.giro, episodioId]);
  }
  const sobran = await all(`SELECT id, key FROM actor_caras WHERE actor_id = $1 AND origen = 'episodio'
    ORDER BY calidad DESC OFFSET $2`, [actorId, MAX_POR_ACTOR]);
  for (const s of sobran) { await q("DELETE FROM actor_caras WHERE id = $1", [s.id]); await storage.borrar(s.key); }
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
