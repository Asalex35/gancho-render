// Procesamiento de imágenes con sharp: validación, miniaturas y portada final 1280x720 con logo.
import sharp from "sharp";
import * as storage from "./storage.js";

sharp.cache(false);
sharp.concurrency(2);

// Reconoce el tipo por los bytes, no por la extensión.
export function tipoImagen(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

// Fotos del cast: se normalizan a JPG de máx. 1600 px y sin metadatos (quita GPS y datos de la cámara).
export async function normalizarFoto(buf) {
  return sharp(buf, { failOn: "error" }).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

export async function miniatura(buf) {
  return sharp(buf).resize(480, 270, { fit: "cover" }).jpeg({ quality: 78 }).toBuffer();
}

// Para mandarle a Claude: máx. 1568 px (lo que Claude aprovecha) y menos de 5 MB.
export async function paraClaude(buf) {
  return sharp(buf).resize(1568, 1568, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}

// Portada final para YouTube: 1280x720, JPG < 2 MB, con el logo del canal abajo a la izquierda.
export async function portadaFinal(imagenKey, logoKey) {
  const base = sharp(await storage.leer(imagenKey)).resize(1280, 720, { fit: "cover" });
  const capas = [];
  if (logoKey) {
    const logo = await sharp(await storage.leer(logoKey)).resize({ width: 256, height: 140, fit: "inside" }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    capas.push({ input: logo, left: 38, top: 720 - meta.height - 36 });
  }
  for (const quality of [90, 84, 76, 68]) {
    const out = await base.clone().composite(capas).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length < 2 * 1024 * 1024 || quality === 68) return out;
  }
}
