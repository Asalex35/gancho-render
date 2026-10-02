// Detector de caras local (gratis, sin enviar fotos a terceros).
// Modelo: Ultra-Light-Fast-Generic-Face-Detector-1MB (licencia MIT) — modelos/caras-rfb320.onnx
// Solo encuentra DÓNDE hay una cara; no identifica a nadie. Quién es quién lo decide Claude por la historia.
import ort from "onnxruntime-node";
import sharp from "sharp";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODELO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../modelos/caras-rfb320.onnx");
const W = 320, H = 240;
let sesion;
const cargar = () => (sesion ??= ort.InferenceSession.create(MODELO, { logSeverityLevel: 3, intraOpNumThreads: 2 }));

function iou(a, b) {
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1), x2 = Math.min(a.x2, b.x2), y2 = Math.min(a.y2, b.y2);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const ua = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return ua > 0 ? inter / ua : 0;
}

// Devuelve las caras en píxeles de la imagen original: [{ x1, y1, x2, y2, score, area }] (area = fracción del cuadro).
export async function detectar(imagen) {
  const s = await cargar();
  const meta = await sharp(imagen).metadata();
  const raw = await sharp(imagen).resize(W, H, { fit: "fill" }).removeAlpha().raw().toBuffer();
  const datos = new Float32Array(3 * W * H);
  for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) datos[c * W * H + i] = (raw[i * 3 + c] - 127) / 128;
  const out = await s.run({ input: new ort.Tensor("float32", datos, [1, 3, H, W]) });
  const scores = out.scores.data, boxes = out.boxes.data, n = scores.length / 2;
  const cand = [];
  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1];
    if (score < 0.8) continue;
    cand.push({ x1: boxes[i * 4], y1: boxes[i * 4 + 1], x2: boxes[i * 4 + 2], y2: boxes[i * 4 + 3], score });
  }
  cand.sort((a, b) => b.score - a.score);
  const caras = [];
  for (const c of cand) if (!caras.some((k) => iou(k, c) > 0.3)) caras.push(c);
  return caras.map((c) => {
    const x1 = Math.max(0, c.x1) * meta.width, y1 = Math.max(0, c.y1) * meta.height;
    const x2 = Math.min(1, c.x2) * meta.width, y2 = Math.min(1, c.y2) * meta.height;
    return { x1, y1, x2, y2, score: c.score, area: ((x2 - x1) * (y2 - y1)) / (meta.width * meta.height) };
  }).filter((c) => c.x2 - c.x1 > 8 && c.y2 - c.y1 > 8);
}

// Nitidez: varianza del laplaciano dentro de la cara (borrosa ≈ baja).
export async function nitidez(imagen, cara) {
  const r = await sharp(imagen).extract(caja(cara, 1, await sharp(imagen).metadata())).greyscale().resize(128, 128, { fit: "fill" })
    .convolve({ width: 3, height: 3, kernel: [0, 1, 0, 1, -4, 1, 0, 1, 0], offset: 128 }).stats();
  return r.channels[0].stdev;
}

// Caja ampliada alrededor de la cara, dentro de los límites de la imagen.
function caja(c, factor, meta, { abajo = 1 } = {}) {
  const w = c.x2 - c.x1, h = c.y2 - c.y1, cx = (c.x1 + c.x2) / 2, cy = (c.y1 + c.y2) / 2;
  const ancho = w * factor, alto = h * factor;
  let left = cx - ancho / 2, top = cy - alto / 2, height = alto * (abajo > 1 ? 1 : 1);
  if (abajo > 1) { top = c.y1 - h * 0.7; height = h * abajo; }
  left = Math.max(0, Math.round(left)); top = Math.max(0, Math.round(top));
  const width = Math.min(meta.width - left, Math.round(ancho));
  height = Math.min(meta.height - top, Math.round(height));
  return { left, top, width: Math.max(1, width), height: Math.max(1, height) };
}

// Recortes para referencias: la cara de cerca y medio cuerpo (vestuario).
export async function recortes(imagen, cara) {
  const meta = await sharp(imagen).metadata();
  const rostro = await sharp(imagen).extract(caja(cara, 2.2, meta)).resize(512, 512, { fit: "cover", position: "attention" }).jpeg({ quality: 90 }).toBuffer();
  const medio = await sharp(imagen).extract(caja(cara, 3.4, meta, { abajo: 5.5 })).resize(640, 800, { fit: "cover", position: "north" }).jpeg({ quality: 88 }).toBuffer();
  return { rostro, medio };
}

// Evalúa un cuadro: ¿hay UNA cara protagonista, grande y nítida?
export async function evaluarCuadro(archivo) {
  const caras = await detectar(archivo);
  if (!caras.length) return null;
  const [p, s] = caras.sort((a, b) => b.area - a.area);
  if (p.area < 0.008) return null;            // muy lejos
  if (s && s.area > p.area * 0.45) return null; // dos caras del mismo tamaño: no sabemos de quién es el cuadro
  const nit = await nitidez(archivo, p);
  if (nit < 9) return null;                    // borrosa
  return { cara: p, nitidez: nit, calidad: Math.sqrt(p.area) * Math.min(nit, 40) * p.score };
}
