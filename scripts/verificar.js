// Revisión de instalación: dice en español qué está bien y qué falta. No gasta dinero (solo consultas gratuitas).
//   npm run verificar
// Sale con código 1 si algo obligatorio falla (sirve para el script de despliegue).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const env = process.env;
let fallas = 0, avisos = 0;
const ok = (t) => console.log(`  ✅ ${t}`);
const mal = (t) => { fallas++; console.log(`  ❌ ${t}`); };
const ojo = (t) => { avisos++; console.log(`  ⚠️  ${t}`); };
const seccion = (t) => console.log(`\n${t}`);
const get = async (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(15000), redirect: "error" });

seccion("1. Sistema");
Number(process.versions.node.split(".")[0]) >= 22 ? ok(`Node ${process.versions.node}`) : mal(`Node ${process.versions.node}: se necesita 22 o más`);
ok(`${os.platform()} ${os.arch()} · ${Math.round(os.totalmem() / 1024 ** 3)} GB de RAM · ${os.cpus().length} CPU`);
if (os.totalmem() < 1.8 * 1024 ** 3) ojo("Menos de 2 GB de RAM: leer videos largos puede ir lento (agrega swap o usa ROLE=worker en otro servidor).");
env.NODE_ENV === "production" ? ok("NODE_ENV=production") : ojo("NODE_ENV no es production");

seccion("2. Variables obligatorias");
for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "SESSION_SECRET", "PUBLIC_BASE_URL"]) env[k] ? ok(k) : mal(`Falta ${k}`);
env.GOOGLE_API_KEY || env.NANOBANANA_API_KEY || env.FAL_KEY ? ok(`Imágenes: ${(env.IMAGE_PROVIDERS || "google,nanobanana,fal")}`) : mal("Falta una llave de imágenes (GOOGLE_API_KEY recomendada)");
if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) mal("SESSION_SECRET muy corta (mínimo 32 caracteres)");
if (!env.LINK_SECRET) ojo("Sin LINK_SECRET: se deriva de SESSION_SECRET (mejor una propia)");
if (env.LINK_SECRET && env.LINK_SECRET === env.SESSION_SECRET) mal("LINK_SECRET debe ser distinta de SESSION_SECRET");

seccion("3. Conexión con el ERP");
env.ERP_SSO_SECRET ? ok("ERP_SSO_SECRET (inicio desde el ERP)") : mal("Falta ERP_SSO_SECRET (la misma que GANCHO_SSO_SECRET del ERP)");
env.ERP_SOLO === "1" ? ok("ERP_SOLO=1 (solo se entra desde el ERP)") : ojo("ERP_SOLO no es 1: también se puede entrar con usuario y contraseña de Gancho");
env.ERP_BITACORA_URL && env.ERP_BITACORA_SECRET ? ok(`Bitácora → ${env.ERP_BITACORA_URL}`) : ojo("Sin ERP_BITACORA_URL/ERP_BITACORA_SECRET: la bitácora solo queda en Gancho");
if (env.ERP_BITACORA_URL && !(env.ERP_BITACORA_CF_ID && env.ERP_BITACORA_CF_SECRET)) ojo("Sin ERP_BITACORA_CF_ID/ERP_BITACORA_CF_SECRET: Cloudflare Access del ERP bloqueará la bitácora");
env.ERP_LIMITE_USD ? ok(`Límite por trabajo: US$${env.ERP_LIMITE_USD} (más, solo un administrador)`) : ojo("Sin ERP_LIMITE_USD (regla del ERP: US$5)");
if (env.CF_ACCESS_TEAM && env.CF_ACCESS_AUD) ok("Cloudflare Access verificado por Gancho (CF_ACCESS_TEAM + CF_ACCESS_AUD)");
else if (env.ERP_SOLO === "1" && env.NODE_ENV === "production") mal("Faltan CF_ACCESS_TEAM y CF_ACCESS_AUD: en el servidor del ERP Gancho debe verificar el pase de Cloudflare");
else ojo("Sin CF_ACCESS_TEAM/CF_ACCESS_AUD: Gancho confía solo en que Cloudflare esté delante");
if (env.CF_ACCESS_TEAM) {
  try { const r = await get(`https://${env.CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`); r.ok ? ok("Llaves de Cloudflare Access alcanzables") : mal(`Cloudflare Access respondió ${r.status}: revisa CF_ACCESS_TEAM`); }
  catch (e) { mal(`No se pudo llegar a Cloudflare Access: ${e.message}`); }
}
env.HOST === "127.0.0.1" ? ok("Escucha solo dentro del servidor (HOST=127.0.0.1)") : ojo(`HOST=${env.HOST || "0.0.0.0"}: en el servidor del ERP debe ser 127.0.0.1`);
/^https:\/\//.test(env.PUBLIC_BASE_URL || "") ? ok(`Dirección pública: ${env.PUBLIC_BASE_URL}`) : ojo("PUBLIC_BASE_URL debería ser https://portadas.erp-prismaticoos.com");

seccion("4. Base de datos");
let db;
try {
  db = await import("../src/db.js");
  const { config, sslDe } = await import("../src/config.js");
  const ssl = sslDe();
  ok(ssl === false ? "Sin TLS (socket o localhost)" : ssl.rejectUnauthorized ? "TLS verificado con certificado (verify-full)" : "TLS sin verificar el certificado");
  if (ssl && !ssl.rejectUnauthorized && config.prod) ojo("En la base administrada usa DATABASE_SSL_CA o sslrootcert para verificar el certificado");
  const r = await db.one("SELECT version() AS v, current_database() AS d");
  ok(`Conectada a «${r.d}» (${r.v.split(" ").slice(0, 2).join(" ")})`);
  await db.migrar();
  const t = await db.one("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'");
  ok(`Tablas creadas/actualizadas (${t.n})`);
} catch (e) { mal(`Base de datos: ${e.message}`); }

seccion("5. Almacenamiento");
try {
  const storage = await import("../src/storage.js");
  await storage.init();
  const key = await storage.guardar("mini", Buffer.from("prueba"), "jpg");
  const leido = (await storage.leer(key)).toString();
  await storage.borrar(key);
  leido === "prueba" ? ok(storage.esS3 ? `Spaces/S3: escribir, leer y borrar (${env.S3_BUCKET})` : `Disco local: escribir, leer y borrar (${env.DATA_DIR || "./data"})`) : mal("El archivo leído no coincide");
  if (!storage.esS3) {
    const d = await fs.statfs(env.DATA_DIR || "./data");
    const libre = (d.bavail * d.bsize) / 1024 ** 3;
    libre > 40 ? ok(`${libre.toFixed(0)} GB libres`) : ojo(`Solo ${libre.toFixed(0)} GB libres: un video puede pesar hasta ${env.MAX_VIDEO_GB || 30} GB (usa Spaces o un volumen más grande)`);
  }
} catch (e) { mal(`Almacenamiento: ${e.message}`); }

seccion("6. Video y caras (local, sin costo)");
try {
  const { default: ffmpeg } = await import("ffmpeg-static");
  const r = spawnSync(ffmpeg, ["-version"], { encoding: "utf8" });
  r.status === 0 ? ok(`ffmpeg ${r.stdout.split(" ")[2]}`) : mal("ffmpeg no corre");
} catch (e) { mal(`ffmpeg: ${e.message}`); }
try {
  const sharp = (await import("sharp")).default;
  const img = await sharp({ create: { width: 320, height: 320, channels: 3, background: "#888" } }).jpeg().toBuffer();
  const caras = await import("../src/caras.js");
  await caras.detectar(img);
  ok("Modelos de caras cargan y corren (YuNet + SFace)");
} catch (e) { mal(`Detector de caras: ${e.message}`); }

seccion("7. Proveedores de IA (consultas gratis, sin generar nada)");
const prueba = async (nombre, fn) => { try { const t = await fn(); ok(`${nombre}${t ? `: ${t}` : ""}`); } catch (e) { mal(`${nombre}: ${e.message}`); } };
const revisar = async (r) => { if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? "llave rechazada" : `respondió ${r.status}`); return r.json(); };
await prueba("Claude (Anthropic)", async () => { await revisar(await get("https://api.anthropic.com/v1/models?limit=1", { headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" } })); });
if (env.GOOGLE_API_KEY) await prueba("Google Gemini (imágenes)", async () => {
  const j = await revisar(await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": env.GOOGLE_API_KEY } }));
  const img = (j.models || []).map((m) => m.name.replace("models/", "")).filter((n) => /image/.test(n));
  if (!img.length) throw new Error("la llave no ve modelos de imagen (¿Generative Language API activada?)");
  return `modelos de imagen: ${img.slice(0, 4).join(", ")} (recuerda: requiere facturación activa)`;
});
if (env.NANOBANANA_API_KEY) await prueba("Nano Banana (respaldo)", async () => { const nb = await import("../src/ai/nanobanana.js"); const c = await nb.creditos({ espera: 15000, fresco: true }); if (c == null) throw new Error("no respondió el saldo"); return `${c} créditos`; });
if (env.FAL_KEY) ok("fal.ai configurado (respaldo final)");
if (env.ELEVENLABS_API_KEY) await prueba("ElevenLabs (transcripción)", async () => { await revisar(await get("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": env.ELEVENLABS_API_KEY } })); });
else ojo("Sin ELEVENLABS_API_KEY: los videos se leen sin transcripción (solo con subtítulos si se suben)");
if (env.YOUTUBE_API_KEY) await prueba("YouTube Data API (vista previa)", async () => { await revisar(await get(`https://www.googleapis.com/youtube/v3/videoCategories?part=snippet&regionCode=MX&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`)); });
else ojo("Sin YOUTUBE_API_KEY: la vista «Cómo se ve en YouTube» usa ejemplos fijos");

seccion("Resultado");
console.log(fallas ? `  ❌ ${fallas} cosa(s) por arreglar y ${avisos} aviso(s).` : `  ✅ Todo listo${avisos ? ` (con ${avisos} aviso(s))` : ""}.`);
await db?.pool.end().catch(() => {});
process.exit(fallas ? 1 : 0);
