// Gancho by Prismáticoos
// ROLE=all (por defecto) corre la web y los workers juntos.
// Para escalar: un servicio con ROLE=web y uno o más con ROLE=worker.
import { config } from "./src/config.js";
import { migrar, pool } from "./src/db.js";
import { sembrarUsuarios } from "./src/auth.js";
import { sembrarCanales } from "./src/repo.js";
import * as storage from "./src/storage.js";
import { iniciarCola, iniciarWorkers, boss } from "./src/jobs.js";
import { crearApp } from "./src/web.js";

await migrar();
await sembrarCanales();
await sembrarUsuarios();
await storage.init();
await iniciarCola();

let server;
if (config.role === "all" || config.role === "web") {
  server = crearApp().listen(config.port, () => {
    console.log(`Gancho listo en ${config.publicBaseUrl}`);
    if (!config.refsPublicas) console.log("ℹ️  Modo local: Nano Banana no puede ver las fotos del cast (usa S3/R2 o publica la app).");
  });
}
if (config.role === "all" || config.role === "worker") await iniciarWorkers();

async function apagar() {
  console.log("Cerrando…");
  server?.close();
  await boss.stop({ graceful: true, timeout: 20000 }).catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", apagar);
process.on("SIGINT", apagar);
