// Respaldo completo para mudar Gancho de servidor: tablas en JSON + archivos (sin videos originales),
// en un .tar.gz. Lo baja el administrador en Administración › Respaldo y Luis lo carga en el servidor nuevo con
// `npm run importar -- respaldo.tar.gz`. Formato tar «ustar» simple, sin dependencias.
import zlib from "node:zlib";
import fs from "node:fs/promises";
import { once } from "node:events";
import { q, tx } from "./db.js";
import * as storage from "./storage.js";

// En orden de llaves foráneas (padres primero).
export const TABLAS = ["usuarios", "canales", "actores", "actor_caras", "lotes", "episodios", "propuestas", "versiones",
  "formatos", "feedback", "uso", "competencia", "bitacora"];
const CARPETAS = storage.CARPETAS.filter((c) => c !== "videos"); // los videos originales se borran solos a los 3 días
const COLUMNAS_USUARIO = ["usuario", "creado_por"];

function cabecera(nombre, tamano) {
  const h = Buffer.alloc(512);
  h.write(nombre.slice(0, 100), 0);
  h.write("0000644\0", 100); h.write("0000000\0", 108); h.write("0000000\0", 116);
  h.write(tamano.toString(8).padStart(11, "0") + "\0", 124);
  h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
  h.write("        ", 148); h.write("0", 156); h.write("ustar\0", 257); h.write("00", 263);
  let suma = 0; for (const b of h) suma += b;
  h.write(suma.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

const leerConReintentos = async (key) => {
  for (let i = 0; ; i++) {
    try { return await storage.leer(key); } catch (e) { if (i >= 2) throw e; await new Promise((ok) => setTimeout(ok, 1000 * (i + 1))); }
  }
};

export async function exportar(salida) {
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(salida);
  // Si el cliente cancela la descarga, se deja de trabajar (no se queda esperando para siempre).
  let cortado = null;
  const cortar = () => { cortado ||= new Error("La descarga se canceló."); gz.destroy(); };
  salida.once("close", () => { if (!salida.writableFinished) cortar(); });
  const escribir = async (nombre, buf) => {
    for (const parte of [cabecera(nombre, buf.length), buf, Buffer.alloc((512 - (buf.length % 512)) % 512)]) {
      if (cortado) throw cortado;
      if (!gz.write(parte)) await new Promise((ok) => { const fin = () => { gz.off("drain", fin); gz.off("close", fin); ok(); }; gz.on("drain", fin); gz.on("close", fin); });
    }
  };
  try {
    return await escribirTodo(escribir, gz, salida);
  } catch (e) { gz.destroy(); throw cortado || e; }
}

async function escribirTodo(escribir, gz, salida) {
  const resumen = { version: 1, creado: new Date().toISOString(), tablas: {}, archivos: 0, omitidos: [] };
  for (const t of TABLAS) {
    const { rows } = await q(`SELECT * FROM ${t}`);
    resumen.tablas[t] = rows.length;
    await escribir(`tablas/${t}.json`, Buffer.from(JSON.stringify(rows)));
  }
  for (const c of CARPETAS) {
    for await (const key of storage.listar(c)) {
      const buf = await leerConReintentos(key).catch((e) => { resumen.omitidos.push(`${key}: ${e.message}`); return null; });
      if (buf) { await escribir(`archivos/${key}`, buf); resumen.archivos++; }
    }
  }
  await escribir("resumen.json", Buffer.from(JSON.stringify(resumen, null, 2)));
  gz.end(Buffer.alloc(1024));
  await once(salida, "finish").catch(() => {});
  return resumen;
}

function* entradas(tar) {
  for (let i = 0; i + 512 <= tar.length;) {
    const h = tar.subarray(i, i + 512);
    if (h.every((b) => b === 0)) return;
    const nombre = h.subarray(0, 100).toString().replace(/\0.*$/s, "");
    const tamano = parseInt(h.subarray(124, 136).toString().replace(/\0.*$/s, "").trim() || "0", 8);
    yield { nombre, datos: tar.subarray(i + 512, i + 512 + tamano) };
    i += 512 + Math.ceil(tamano / 512) * 512;
  }
}

// renombrar: { "anapau": "ana.paula" } para que el historial quede con el usuario del ERP (parte antes de @ del correo).
export async function importar(archivo, { renombrar = {}, forzar = false } = {}) {
  const tar = zlib.gunzipSync(await fs.readFile(archivo));
  const tablas = {}, archivos = [];
  let resumen = null;
  for (const e of entradas(tar)) {
    if (e.nombre === "resumen.json") resumen = JSON.parse(e.datos);
    else if (e.nombre.startsWith("tablas/")) tablas[e.nombre.slice(7, -5)] = JSON.parse(e.datos);
    else if (e.nombre.startsWith("archivos/")) archivos.push(e);
  }
  if (!resumen) throw new Error("El archivo no es un respaldo de Gancho (falta resumen.json).");
  if (resumen.omitidos?.length) console.warn(`⚠️  El respaldo dice que ${resumen.omitidos.length} archivo(s) no se pudieron leer en el servidor viejo:\n   ${resumen.omitidos.slice(0, 20).join("\n   ")}`);
  const { rows: [{ n }] } = await q("SELECT count(*)::int AS n FROM episodios");
  if (n && !forzar) throw new Error(`Este Gancho ya tiene ${n} episodios. Importa en una base nueva o usa --forzar.`);
  const ren = (v) => (typeof v === "string" && renombrar[v] ? renombrar[v] : v);
  // Primero los archivos (si algo falla a medias, no quedan filas apuntando a imágenes que no existen).
  for (const a of archivos) {
    const key = a.nombre.slice(9);
    if (storage.keyValida(key)) await storage.guardarEn(key, Buffer.from(a.datos));
  }
  await tx(async (c) => {
    if (tablas.canales?.length && !n) await c.query("DELETE FROM canales WHERE id NOT IN (SELECT DISTINCT canal FROM episodios UNION SELECT DISTINCT canal FROM lotes)");
    for (const t of TABLAS) {
      const filas = (tablas[t] || []).map((f) => {
        const o = { ...f };
        for (const k of COLUMNAS_USUARIO) if (k in o) o[k] = ren(o[k]);
        if (o.imagen?.usuario) o.imagen = { ...o.imagen, usuario: ren(o.imagen.usuario) };
        return o;
      });
      for (let i = 0; i < filas.length; i += 500) {
        await c.query(`INSERT INTO ${t} SELECT * FROM jsonb_populate_recordset(null::${t}, $1::jsonb) ON CONFLICT DO NOTHING`, [JSON.stringify(filas.slice(i, i + 500))]);
      }
    }
    // Las tablas con id autonumérico deben seguir después del último id importado.
    for (const t of ["feedback", "bitacora"]) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST(COALESCE((SELECT max(id) FROM ${t}), 0), 1), (SELECT count(*) > 0 FROM ${t}))`);
    }
  });
  return { ...resumen, archivosCargados: archivos.length };
}
