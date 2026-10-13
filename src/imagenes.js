// Procesamiento de imágenes con sharp: validación, miniaturas y portada final 1280x720 con logo.
import sharp from "sharp";
import * as storage from "./storage.js";

sharp.cache(false);
// Protección contra "bombas" de imagen: un PNG pequeño de 15000×15000 px agotaría la memoria.
const LIM = { limitInputPixels: 40e6, failOn: "error" };
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
  return sharp(buf, LIM).rotate().resize(1600, 1600, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
}

export async function miniatura(buf) {
  return sharp(buf, LIM).resize(480, 270, { fit: "cover" }).jpeg({ quality: 78 }).toBuffer();
}

// Para mandarle a Claude: máx. 1568 px (lo que Claude aprovecha) y menos de 5 MB.
export async function paraClaude(buf, max = 1568) {
  return sharp(buf, LIM).resize(max, max, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
}
// Portada recién generada: máx. 1920 px de ancho (YouTube usa 1280×720). Archivos más ligeros = pantalla y revisión más rápidas.
export async function reducirPortada(buf) {
  return sharp(buf, LIM).resize(1920, 1080, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 88, mozjpeg: true }).toBuffer();
}

// Portada final para YouTube: 1280x720, JPG < 2 MB, con el logo del canal abajo a la izquierda.
export async function portadaFinal(imagenKey, logoKey) {
  const base = sharp(await storage.leer(imagenKey), LIM).resize(1280, 720, { fit: "cover" });
  const capas = [];
  if (logoKey) {
    const logo = await sharp(await storage.leer(logoKey), LIM).resize({ width: 256, height: 140, fit: "inside" }).png().toBuffer();
    const meta = await sharp(logo).metadata();
    capas.push({ input: logo, left: 38, top: 720 - meta.height - 36 });
  }
  for (const quality of [90, 84, 76, 68]) {
    const out = await base.clone().composite(capas).jpeg({ quality, mozjpeg: true }).toBuffer();
    if (out.length < 2 * 1024 * 1024 || quality === 68) return out;
  }
}

// Portada subida por el equipo: se guarda en JPG 16:9 (máx. 2560 px) y sin metadatos.
export async function portadaPropia(buf) {
  return sharp(buf, LIM).rotate().resize(2560, 1440, { fit: "cover", withoutEnlargement: true }).jpeg({ quality: 90 }).toBuffer();
}

// Portadas oscuras se pierden junto a las de la competencia (promedio medido: ~116 de 255).
// Si la imagen queda por debajo, se levantan sombras y medios con una curva gamma (no quema las luces).
export const LUZ_MINIMA = 105;
export async function aclarar(buf, objetivo = 120) {
  const luz = async (b) => (await sharp(b, LIM).resize(320, 180).greyscale().stats()).channels[0].mean;
  const antes = await luz(buf);
  if (antes >= LUZ_MINIMA) return { buf, antes: Math.round(antes), despues: Math.round(antes), cambio: false };
  const exp = Math.min(1, Math.max(0.5, Math.log(objetivo / 255) / Math.log(Math.max(antes, 20) / 255)));
  const { data, info } = await sharp(buf, LIM).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const curva = Uint8Array.from({ length: 256 }, (_, i) => Math.round(255 * Math.pow(i / 255, exp)));
  for (let i = 0; i < data.length; i++) data[i] = curva[data[i]];
  const out = await sharp(data, { raw: info }).modulate({ saturation: 1.1 }).jpeg({ quality: 92, mozjpeg: true }).toBuffer();
  return { buf: out, antes: Math.round(antes), despues: Math.round(await luz(out)), cambio: true };
}

// Formatos para redes y Prisma Plus: medida exacta de cada plataforma, JPG de alta calidad.
export async function formatoFinal(key, ancho, alto) {
  return sharp(await storage.leer(key), LIM).resize(ancho, alto, { fit: "cover", position: "attention" }).jpeg({ quality: 90, mozjpeg: true }).toBuffer();
}
export async function miniaturaFormato(buf) {
  return sharp(buf, LIM).resize(420, 420, { fit: "inside" }).jpeg({ quality: 80 }).toBuffer();
}
