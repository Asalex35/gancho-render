// Almacenamiento de imágenes. Local (disco) para pruebas; S3 / Cloudflare R2 para producción y para escalar a varias instancias.
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "./config.js";

const S = config.storage;
const MIME = { jpg: "image/jpeg", png: "image/png", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mkv: "video/x-matroska", m4v: "video/mp4" };
export const EXT_VIDEO = ["mp4", "mov", "webm", "mkv", "m4v"];
export const mimeDe = (key) => MIME[key.split(".").pop()] || "application/octet-stream";
const KEY_OK = /^[a-z]+\/[A-Za-z0-9_-]+\.(jpg|png|webp|svg|mp4|mov|webm|mkv|m4v)$/;
export const keyValida = (k) => KEY_OK.test(k || "");

const s3 = S.driver === "s3"
  ? new S3Client({ region: S.region, endpoint: S.endpoint, forcePathStyle: S.forcePathStyle, requestHandler: { requestTimeout: 120000, connectionTimeout: 10000 }, credentials: { accessKeyId: S.accessKeyId, secretAccessKey: S.secretAccessKey } })
  : null;
const local = (key) => path.resolve(S.localDir, key);

export async function init() {
  // Falla al arrancar (y no al guardar una imagen ya pagada) si el bucket está mal configurado.
  if (s3) {
    try { await s3.send(new HeadBucketCommand({ Bucket: S.bucket })); }
    catch (e) { throw new Error(`No pude entrar al bucket "${S.bucket}": revisa S3_ENDPOINT y las llaves (${e.name}).`); }
    return;
  }
  for (const d of ["actores", "portadas", "mini", "logos", "videos", "cuadros", "rostros"]) await fs.mkdir(path.resolve(S.localDir, d), { recursive: true });
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
  const a = Buffer.from(String(sig)), b = Buffer.from(esperada);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---------- Videos (archivos grandes) ----------
export const nuevaKey = (carpeta, ext) => `${carpeta}/${crypto.randomBytes(15).toString("base64url")}.${ext}`;

// Para que el navegador suba el video directo a R2/S3 sin pasar por el servidor.
export async function urlDeSubida(key) {
  return getSignedUrl(s3, new PutObjectCommand({ Bucket: S.bucket, Key: key, ContentType: mimeDe(key) }), { expiresIn: 6 * 3600 });
}
export async function existe(key) {
  if (!keyValida(key)) return false;
  if (!s3) return fs.stat(local(key)).then(() => true, () => false);
  return s3.send(new HeadObjectCommand({ Bucket: S.bucket, Key: key })).then(() => true, () => false);
}
// Guarda un archivo que ya está en disco (subida local de video) sin cargarlo completo en memoria.
export async function guardarDesdeArchivo(key, ruta) {
  if (s3) {
    const { size } = await fs.stat(ruta);
    await s3.send(new PutObjectCommand({ Bucket: S.bucket, Key: key, Body: createReadStream(ruta), ContentLength: size, ContentType: mimeDe(key) }));
    await fs.rm(ruta, { force: true });
  } else await fs.rename(ruta, local(key)).catch(async () => { await fs.copyFile(ruta, local(key)); await fs.rm(ruta, { force: true }); });
  return key;
}
// Entrada para ffmpeg: ruta local o URL firmada (ffmpeg lee por rangos, no descarga todo).
export async function entradaFfmpeg(key) {
  if (!s3) return local(key);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: S.bucket, Key: key }), { expiresIn: 6 * 3600 });
}
