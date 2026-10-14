// Carga un respaldo de Gancho (Administración › Descargar respaldo) en este servidor.
//   npm run importar -- gancho-respaldo.tar.gz [--renombrar anapau=ana.paula,carlos=carlos.ortiz] [--forzar]
// --renombrar: usuarios viejos → usuario del ERP (la parte antes de @ del correo), para que cada quien vea su historial.
import { migrar } from "../src/db.js";
import { importar } from "../src/respaldo.js";
import * as storage from "../src/storage.js";
import { pool } from "../src/db.js";

const args = process.argv.slice(2);
const archivo = args.find((a) => !a.startsWith("--"));
const valor = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };
if (!archivo) { console.error("Uso: npm run importar -- <respaldo.tar.gz> [--renombrar viejo=nuevo,...] [--forzar]"); process.exit(1); }
const renombrar = Object.fromEntries(String(valor("--renombrar") || "").split(",").filter(Boolean).map((p) => p.split("=").map((s) => s.trim())));
try {
  await migrar();
  await storage.init();
  const r = await importar(archivo, { renombrar, forzar: args.includes("--forzar") });
  console.log("✅ Respaldo cargado.");
  for (const [t, n] of Object.entries(r.tablas)) console.log(`   ${t}: ${n}`);
  console.log(`   archivos: ${r.archivosCargados}`);
} catch (e) {
  console.error("❌", e.message);
  process.exitCode = 1;
} finally {
  await pool.end().catch(() => {});
}
