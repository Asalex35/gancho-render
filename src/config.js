// Toda la configuración sale de variables de entorno. Ver .env.example.
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

const env = process.env;
const PROD = env.NODE_ENV === "production";
const num = (v, d) => (v === undefined || v === "" ? d : Number(v));

const PORT = num(env.PORT, 3000);
const PUBLIC_BASE_URL = (env.PUBLIC_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");

function requerido(k) {
  if (!env[k]) throw new Error(`Falta la variable ${k}. Revisa .env.example`);
  return env[k];
}

export const config = {
  prod: PROD,
  port: PORT,
  // En los servidores del ERP: 127.0.0.1 (solo nginx/cloudflared llegan). En un contenedor: 0.0.0.0.
  host: env.HOST || "0.0.0.0",
  // web = solo interfaz y API · worker = solo procesa la cola · all = las dos cosas (lo más simple)
  role: env.ROLE || "all",
  publicBaseUrl: PUBLIC_BASE_URL,
  databaseUrl: requerido("DATABASE_URL"),
  anthropicKey: requerido("ANTHROPIC_API_KEY"),
  // Imágenes: basta con UN proveedor (Google oficial, nanobananaapi.ai o fal.ai); el orden lo da IMAGE_PROVIDERS.
  nanoBananaKey: env.NANOBANANA_API_KEY || "",
  // Haiku (barato) para descripción, tags, revisión de portadas y lo mecánico.
  // Sonnet para lo creativo (títulos, ideas de portada, entender el video): con Haiku los títulos salían narrativos.
  claudeModel: env.CLAUDE_MODEL || "claude-haiku-5-5",
  claudeModelCreativo: env.CLAUDE_MODEL_CREATIVO || "claude-sonnet-5-5",
  sessionSecret: env.SESSION_SECRET || (PROD ? requerido("SESSION_SECRET") : crypto.randomBytes(32).toString("hex")),
  // Firma de los enlaces temporales de fotos para Nano Banana (modo almacenamiento local)
  linkSecret: env.LINK_SECRET || (env.SESSION_SECRET ? crypto.createHmac("sha256", env.SESSION_SECRET).update("enlaces-publicos").digest("hex") : crypto.randomBytes(32).toString("hex")),
  callbackSecret: env.CALLBACK_SECRET || crypto.randomBytes(16).toString("hex"),
  admin: { user: env.ADMIN_USER, password: env.ADMIN_PASSWORD },
  legacyUsers: env.APP_USERS || "",
  mockImages: env.NANOBANANA_MOCK === "1" && !PROD,
  imageResolution: env.IMAGE_RESOLUTION || "1K",
  creditsPerImage: num(env.CREDITS_PER_IMAGE, 18), // Nano Banana Pro 1K/2K en nanobananaapi.ai
  limits: {
    // Coherente con los lotes: 200 episodios × 3 portadas = 600, más reintentos.
    userDailyImages: num(env.DAILY_IMAGE_LIMIT, 700),
    orgDailyImages: num(env.ORG_DAILY_IMAGE_LIMIT, 3000),
    maxEpisodesPerBatch: num(env.MAX_EPISODES_PER_BATCH, 200),
  },
  concurrency: {
    claude: num(env.CLAUDE_CONCURRENCY, 4),
    images: num(env.IMAGE_CONCURRENCY, 6),
    polling: num(env.POLL_CONCURRENCY, 6),
  },
  storage: {
    driver: env.S3_BUCKET ? "s3" : "local",
    localDir: env.DATA_DIR || "./data",
    bucket: env.S3_BUCKET,
    region: env.S3_REGION || "auto",
    endpoint: env.S3_ENDPOINT, // R2: https://<cuenta>.r2.cloudflarestorage.com · Supabase: https://<proyecto>.storage.supabase.co/storage/v1/s3
    // Supabase (y MinIO) necesitan el estilo de ruta: https://endpoint/bucket/archivo
    forcePathStyle: env.S3_FORCE_PATH_STYLE ? env.S3_FORCE_PATH_STYLE === "1" : /supabase/.test(env.S3_ENDPOINT || ""),
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
};

// Nano Banana descarga las fotos del cast por URL: necesita una URL que exista en internet.
config.refsPublicas = config.storage.driver === "s3" || !/localhost|127\.0\.0\.1/.test(PUBLIC_BASE_URL);

// Web y worker separados no comparten disco: las imágenes tienen que ir a S3/R2.
if (config.prod && config.storage.driver === "local" && !env.DATA_DIR) {
  throw new Error("En producción usa S3/R2 (S3_BUCKET) o un disco persistente montado en DATA_DIR; si no, las portadas se pierden en cada deploy.");
}
if (config.role !== "all" && config.storage.driver === "local" && config.prod) {
  throw new Error("Con ROLE=web/worker separados necesitas S3/R2 (S3_BUCKET). O usa ROLE=all en un solo servicio.");
}

// TLS de Postgres. Socket local o localhost: sin TLS. Base administrada (DigitalOcean): con su certificado y verificando
// el nombre (verify-full) si se da DATABASE_SSL_CA o sslrootcert en la URL; si no, cifrado sin verificar.
export function sslDe(url = config.databaseUrl) {
  let u = null;
  try { u = new URL(url); } catch {}
  const host = u ? (u.searchParams.get("host") || decodeURIComponent(u.hostname)) : "";
  if (env.DATABASE_SSL === "off" || !host || host.startsWith("/") || ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host)) return false;
  const ca = env.DATABASE_SSL_CA || u?.searchParams.get("sslrootcert") || "";
  if (ca) return { ca: readFileSync(ca, "utf8"), rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

if (!env.GOOGLE_API_KEY && !env.NANOBANANA_API_KEY && !env.FAL_KEY && !config.mockImages) {
  throw new Error("Falta una llave de imágenes: GOOGLE_API_KEY (recomendada), NANOBANANA_API_KEY o FAL_KEY. Revisa .env.example");
}
