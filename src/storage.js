// Almacenamiento de imágenes. Local (disco) para pruebas; S3 / Cloudflare R2 para producción y para escalar a varias instancias.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

const S = config.storage;
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml" };
export const mimeDe = (key) => MIME[key.split(".").pop()] || "application/octet-stream";
const KEY_OK = /^[a-z]+\/[A-Za-z0-9_-]+\.(jpg|png|webp|svg)$/;
export const keyValida = (k) => KEY_OK.test(k || "");

const s3 = S.driver === "s3"
  ? new S3Client({ region: S.region, endpoint: S.endpoint, credentials: { accessKeyId: S.accessKeyId, secretAccessKey: S.secretAccessKey } })
  : null;
const local = (key) => path.resolve(S.localDir, key);

export async function init() {
  if (!s3) for (const d of ["actores", "portadas", "mini", "logos"]) await fs.mkdir(path.resolve(S.localDir, d), { recursive: true });
}

export async function guardar(carpeta, buffer, ext) {
  const key = `${carpeta}/${crypto.randomBytes(15).toString("base64url")}.${ext}`;
  if (s3) await s3.send(new PutObjectCommand({ Bucket: S.bucket, Key: key, Body: buffer, ContentType: mimeDe(key) }));
  else await fs.writeFile(local(key), buffer);
  return key;
}

export async function leer(key) {
  if (!keyValida(key)) throw new Error("llave inválida");
  if (!s3) return fs.readFile(local(key));
  const r = await s3.send(new GetObjectCommand({ Bucket: S.bucket, Key: key }));
  return Buffer.from(await r.Body.transformToByteArray());
}

export async function borrar(key) {
  if (!keyValida(key)) return;
  if (s3) await s3.send(new DeleteObjectCommand({ Bucket: S.bucket, Key: key })).catch(() => {});
  else await fs.rm(local(key), { force: true });
}

// URL para el navegador del equipo (detrás del login). En S3 redirige a una URL firmada.
export async function urlPrivada(key) {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S.bucket, Key: key }), { expiresIn: 3600 });
}
export const rutaLocal = local;
export const esS3 = Boolean(s3);

// URL que Nano Banana puede descargar sin login. Caduca en 2 horas.
export async function urlPublica(key) {
  if (s3) return getSignedUrl(s3, new GetObjectCommand({ Bucket: S.bucket, Key: key }), { expiresIn: 7200 });
  const exp = Date.now() + 2 * 3600e3;
  return `${config.publicBaseUrl}/pub/${key}?exp=${exp}&sig=${firmar(key, exp)}`;
}
const firmar = (key, exp) => crypto.createHmac("sha256", config.linkSecret).update(`${key}|${exp}`).digest("base64url");
export function verificarEnlace(key, exp, sig) {
  if (!keyValida(key) || !sig || Number(exp) < Date.now()) return false;
  const esperada = firmar(key, Number(exp));
  return sig.length === esperada.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(esperada));
}
