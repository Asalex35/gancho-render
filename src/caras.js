// Rostros: detección, calidad, comparación y recortes. Todo corre local (gratis, las fotos no salen del servidor).
// - YuNet (OpenCV Zoo, licencia MIT): encuentra caras y 5 puntos (ojos, nariz, comisuras).
// - SFace (OpenCV Zoo, licencia Apache 2.0): convierte una cara en una "huella" de 128 números para comparar
//   si dos caras son de la misma persona. Se usa con permiso de los actores (ver Administración).
import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../modelos");
const OPC = { logSeverityLevel: 3, intraOpNumThreads: 2 };
let detector, reconocedor;
const cargarDetector = () => (detector ??= ort.InferenceSession.create(path.join(DIR, "face_detection_yunet_2023mar.onnx"), OPC));
const cargarReconocedor = () => (reconocedor ??= ort.InferenceSession.create(path.join(DIR, "face_recognition_sface_2021dec.onnx"), OPC));

// Puntos de referencia de una cara alineada de 112×112 (estándar ArcFace / OpenCV).
const REF = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
export const MISMA_PERSONA = 0.4; // similitud coseno a partir de la cual se considera la misma persona

// ---------- Detección (YuNet) ----------
const S = 640;
export async function detectar(imagen) {
  const s = await cargarDetector();
  const meta = await sharp(imagen).metadata();
  const esc = S / Math.max(meta.width, meta.height);
  const w = Math.round(meta.width * esc), h = Math.round(meta.height * esc);
  const raw = await sharp(imagen).resize(w, h).removeAlpha().extend({ right: S - w, bottom: S - h, background: "#000" }).raw().toBuffer();
  const datos = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) { // BGR, 0-255
    datos[i] = raw[i * 3 + 2]; datos[S * S + i] = raw[i * 3 + 1]; datos[2 * S * S + i] = raw[i * 3];
  }
  const o = await s.run({ input: new ort.Tensor("float32", datos, [1, 3, S, S]) });
  const cand = [];
  for (const paso of [8, 16, 32]) {
    const cols = S / paso, cls = o[`cls_${paso}`].data, obj = o[`obj_${paso}`].data, bb = o[`bbox_${paso}`].data, kp = o[`kps_${paso}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])));
      if (score < 0.75) continue;
      const c = i % cols, r = Math.floor(i / cols);
      const cx = (c + bb[i * 4]) * paso, cy = (r + bb[i * 4 + 1]) * paso, bw = Math.exp(bb[i * 4 + 2]) * paso, bh = Math.exp(bb[i * 4 + 3]) * paso;
      const pts = [];
      for (let k = 0; k < 5; k++) pts.push([(kp[i * 10 + 2 * k] + c) * paso / esc, (kp[i * 10 + 2 * k + 1] + r) * paso / esc]);
      cand.push({ x1: (cx - bw / 2) / esc, y1: (cy - bh / 2) / esc, x2: (cx + bw / 2) / esc, y2: (cy + bh / 2) / esc, score, pts });
    }
  }
  cand.sort((a, b) => b.score - a.score);
  const caras = [];
  for (const c of cand) if (!caras.some((k) => iou(k, c) > 0.3)) caras.push(c);
  return caras.map((c) => {
    const x1 = Math.max(0, c.x1), y1 = Math.max(0, c.y1), x2 = Math.min(meta.width, c.x2), y2 = Math.min(meta.height, c.y2);
    return { ...c, x1, y1, x2, y2, area: ((x2 - x1) * (y2 - y1)) / (meta.width * meta.height), ancho: meta.width, alto: meta.height };
  }).filter((c) => c.x2 - c.x1 > 20 && c.y2 - c.y1 > 20);
}
function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const u = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return u > 0 ? inter / u : 0;
}

// Ángulo de la cara a partir de los puntos: 0 = de frente; ~0.3 = 3/4; >0.5 = casi de perfil.
export function giro(c) {
  const [ojoD, ojoI, nariz] = c.pts;
  const medio = (ojoD[0] + ojoI[0]) / 2, dist = Math.hypot(ojoI[0] - ojoD[0], ojoI[1] - ojoD[1]) || 1;
  return Math.abs(nariz[0] - medio) / dist;
}

// ---------- Huella de la cara (SFace) ----------
// Alinea la cara a 112×112 con una transformación de semejanza (ojos y boca en su lugar) y la pasa por SFace.
export async function huella(imagen, c) {
  const s = await cargarReconocedor();
  // Recorte alrededor de la cara para no cargar la imagen completa (4K) en memoria.
  const m = Math.max(c.x2 - c.x1, c.y2 - c.y1);
  const left = Math.max(0, Math.round(c.x1 - m)), top = Math.max(0, Math.round(c.y1 - m));
  const width = Math.min(c.ancho - left, Math.round(m * 3)), height = Math.min(c.alto - top, Math.round(m * 3));
  const escala = Math.min(1, 600 / Math.max(width, height));
  const W = Math.max(1, Math.round(width * escala)), H = Math.max(1, Math.round(height * escala));
  const raw = await sharp(imagen).extract({ left, top, width, height }).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const src = c.pts.map(([x, y]) => [(x - left) * escala, (y - top) * escala]);
  // Semejanza por mínimos cuadrados con números complejos: dst = a·src + b
  const mz = src.reduce((t, p) => [t[0] + p[0] / 5, t[1] + p[1] / 5], [0, 0]);
  const mw = REF.reduce((t, p) => [t[0] + p[0] / 5, t[1] + p[1] / 5], [0, 0]);
  let nr = 0, ni = 0, d = 0;
  for (let k = 0; k < 5; k++) {
    const zx = src[k][0] - mz[0], zy = src[k][1] - mz[1], wx = REF[k][0] - mw[0], wy = REF[k][1] - mw[1];
    nr += wx * zx + wy * zy; ni += wy * zx - wx * zy; d += zx * zx + zy * zy;
  }
  const ar = nr / d, ai = ni / d, br = mw[0] - (ar * mz[0] - ai * mz[1]), bi = mw[1] - (ar * mz[1] + ai * mz[0]);
  const den = ar * ar + ai * ai;
  const datos = new Float32Array(3 * 112 * 112);
  for (let v = 0; v < 112; v++) for (let u = 0; u < 112; u++) {
    // inversa: z = (w - b) / a
    const px = u - br, py = v - bi;
    const x = (px * ar + py * ai) / den, y = (py * ar - px * ai) / den;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    for (let ch = 0; ch < 3; ch++) {
      const g = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H ? 0 : raw[(yy * W + xx) * 3 + ch]);
      const val = g(x0, y0) * (1 - fx) * (1 - fy) + g(x0 + 1, y0) * fx * (1 - fy) + g(x0, y0 + 1) * (1 - fx) * fy + g(x0 + 1, y0 + 1) * fx * fy;
      datos[ch * 112 * 112 + v * 112 + u] = val; // RGB, 0-255
    }
  }
  const o = await s.run({ data: new ort.Tensor("float32", datos, [1, 3, 112, 112]) });
  const f = Array.from(o.fc1.data);
  const n = Math.hypot(...f) || 1;
  return f.map((x) => x / n);
}
export const similitud = (a, b) => (a && b ? a.reduce((s, x, i) => s + x * b[i], 0) : 0);
export function promedio(huellas) {
  const p = new Array(128).fill(0);
  for (const h of huellas) h.forEach((x, i) => (p[i] += x));
  const n = Math.hypot(...p) || 1;
  return p.map((x) => x / n);
}

// ---------- Calidad y recortes ----------
export async function nitidez(imagen, c) {
  // stats() mide la imagen de entrada, así que primero se genera el recorte filtrado.
  const buf = await sharp(imagen).extract(caja(c, 1)).greyscale().resize(128, 128, { fit: "fill" })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 }).png().toBuffer();
  return (await sharp(buf).stats()).channels[0].stdev;
}
function caja(c, factor, { abajo = 0 } = {}) {
  const w = c.x2 - c.x1, h = c.y2 - c.y1, cx = (c.x1 + c.x2) / 2, cy = (c.y1 + c.y2) / 2;
  let left = cx - (w * factor) / 2, top = cy - (h * factor) / 2, width = w * factor, height = h * factor;
  if (abajo) { top = c.y1 - h * 0.7; height = h * abajo; }
  left = Math.max(0, Math.round(left)); top = Math.max(0, Math.round(top));
  return { left, top, width: Math.max(1, Math.min(c.ancho - left, Math.round(width))), height: Math.max(1, Math.min(c.alto - top, Math.round(height))) };
}
export async function recortes(imagen, c) {
  const rostro = await sharp(imagen).extract(caja(c, 2.2)).resize(768, 768, { fit: "cover", position: "attention", withoutEnlargement: false }).jpeg({ quality: 92 }).toBuffer();
  const medio = await sharp(imagen).extract(caja(c, 3.4, { abajo: 5.5 })).resize(768, 960, { fit: "cover", position: "north" }).jpeg({ quality: 90 }).toBuffer();
  return { rostro, medio };
}

// Todas las caras útiles de un cuadro, con su calidad y su huella.
export async function analizarCuadro(archivo, { minArea = 0.006 } = {}) {
  const todas = await detectar(archivo);
  const utiles = [];
  for (const c of todas) {
    if (c.area < minArea || c.score < 0.8) continue;
    const g = giro(c);
    if (g > 0.6) continue; // de perfil: no sirve de referencia
    const nit = await nitidez(archivo, c);
    if (nit < 8) continue;
    const frontal = 1 - Math.min(1, g * 1.6);
    utiles.push({ cara: c, giro: g, nitidez: nit, sola: todas.filter((k) => k.area > c.area * 0.35).length === 1,
      calidad: Math.sqrt(c.area) * Math.min(nit, 40) * c.score * (0.55 + 0.45 * frontal), huella: await huella(archivo, c) });
  }
  return utiles;
}

// Agrupa caras por persona (sin saber quién es): cada grupo es una persona distinta del episodio.
export function agrupar(caras, umbral = MISMA_PERSONA) {
  const grupos = [];
  for (const c of [...caras].sort((a, b) => b.calidad - a.calidad)) {
    let mejor = null, sim = umbral;
    for (const g of grupos) { const s = similitud(c.huella, g.centro); if (s >= sim) { sim = s; mejor = g; } }
    if (mejor) { mejor.caras.push(c); mejor.centro = promedio(mejor.caras.slice(0, 8).map((x) => x.huella)); }
    else grupos.push({ caras: [c], centro: c.huella });
  }
  return grupos.sort((a, b) => b.caras.length - a.caras.length);
}

// Elige las mejores referencias de un grupo: una de frente, una de 3/4 y la más nítida, sin repetir la misma toma.
export function mejores(grupo, n = 3) {
  const orden = [...grupo.caras].sort((a, b) => (b.sola - a.sola) || (b.calidad - a.calidad));
  const elegidas = [];
  const frente = orden.find((c) => c.giro < 0.15);
  const tresCuartos = orden.find((c) => c.giro >= 0.15 && c.giro <= 0.45);
  for (const c of [frente, tresCuartos, ...orden]) {
    if (!c || elegidas.includes(c) || elegidas.some((e) => Math.abs(e.t - c.t) < 4)) continue;
    elegidas.push(c);
    if (elegidas.length >= n) break;
  }
  return elegidas;
}
