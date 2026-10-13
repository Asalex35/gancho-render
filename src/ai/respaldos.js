// Proveedores de imagen de respaldo. Los dos son síncronos (devuelven la imagen en la misma llamada)
// y reciben las referencias en base64, así que no necesitan URLs públicas.
import { senal } from "../contexto.js";
const conTiempo = senal;

export class ErrorProveedor extends Error {
  constructor(proveedor, msg) { super(`${proveedor}: ${msg}`); this.publico = true; this.proveedor = proveedor; }
}

// ---------- Google Gemini (el Nano Banana oficial) ----------
// https://ai.google.dev/gemini-api/docs/image-generation
const MODELOS_GOOGLE = { nb2: "gemini-3.1-flash-image", pro: "gemini-3-pro-image" };

export const googleDisponible = () => Boolean(process.env.GOOGLE_API_KEY);

export async function generarGoogle({ prompt, refs, modelo, aspecto = "16:9", resolucion }) {
  const model = process.env.GOOGLE_IMAGE_MODEL || MODELOS_GOOGLE[modelo] || MODELOS_GOOGLE.nb2;
  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.base64 } }))] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspecto, imageSize: resolucion || process.env.IMAGE_RESOLUTION || "1K" } },
  };
  let res;
  try {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": process.env.GOOGLE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: conTiempo(180e3),
    });
  } catch { throw new ErrorProveedor("Google", "sin conexión o tardó demasiado"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ErrorProveedor("Google", data.error?.message?.slice(0, 160) || `HTTP ${res.status}`);
  const partes = data.candidates?.[0]?.content?.parts || [];
  const img = partes.map((p) => p.inlineData || p.inline_data).filter(Boolean).at(-1);
  if (!img?.data) {
    const razon = data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || "sin imagen";
    throw new ErrorProveedor("Google", `no devolvió imagen (${razon})`);
  }
  return Buffer.from(img.data, "base64");
}

// ---------- fal.ai · Seedream 4 (otra marca, por si Google también falla) ----------
// https://fal.ai/models/fal-ai/bytedance/seedream/v4/edit
export const falDisponible = () => Boolean(process.env.FAL_KEY);

// Medidas para Seedream según la proporción pedida.
const TAM_FAL = { "16:9": [1344, 756], "9:16": [756, 1344], "4:5": [1088, 1360], "1:1": [1152, 1152], "2:3": [1024, 1536] };
export async function generarFal({ prompt, refs, aspecto = "16:9" }) {
  const ruta = refs.length ? "fal-ai/bytedance/seedream/v4/edit" : "fal-ai/bytedance/seedream/v4/text-to-image";
  const body = { prompt, image_size: { width: (TAM_FAL[aspecto] || TAM_FAL["16:9"])[0], height: (TAM_FAL[aspecto] || TAM_FAL["16:9"])[1] }, num_images: 1, enable_safety_checker: true };
  if (refs.length) body.image_urls = refs.slice(0, 10).map((r) => `data:${r.mime};base64,${r.base64}`);
  let res;
  try {
    res = await fetch(`https://fal.run/${ruta}`, {
      method: "POST", headers: { Authorization: `Key ${process.env.FAL_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: conTiempo(240e3),
    });
  } catch { throw new ErrorProveedor("Seedream", "sin conexión o tardó demasiado"); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ErrorProveedor("Seedream", (data.detail && JSON.stringify(data.detail).slice(0, 160)) || `HTTP ${res.status}`);
  const url = data.images?.[0]?.url;
  if (!url) throw new ErrorProveedor("Seedream", "no devolvió imagen");
  if (url.startsWith("data:")) return Buffer.from(url.split(",")[1], "base64");
  const u = new URL(url);
  if (u.protocol !== "https:") throw new ErrorProveedor("Seedream", "URL no segura");
  const img = await fetch(u, { signal: conTiempo(60e3), redirect: "error" });
  if (!img.ok) throw new ErrorProveedor("Seedream", `descarga falló (${img.status})`);
  return Buffer.from(await img.arrayBuffer());
}
