// Proveedores de imagen síncronos (devuelven la imagen en la misma llamada): Google oficial (principal) y fal.ai.
// Reciben las referencias en base64, así que no necesitan URLs públicas.
import { senal } from "../contexto.js";
const conTiempo = senal;

export class ErrorProveedor extends Error {
  constructor(proveedor, msg) { super(`${proveedor}: ${msg}`); this.publico = true; this.proveedor = proveedor; }
}

// ---------- Google Gemini (el Nano Banana oficial) ----------
// https://ai.google.dev/gemini-api/docs/image-generation · Recibe las fotos de los actores en base64: no necesita URL pública.
// Google está pasando de generateContent a la "Interactions API": se intenta la nueva y, si no responde, la clásica.
// Se recuerda cuál funcionó para no pagar dos intentos cada vez.
const MODELOS_GOOGLE = { nb2: "gemini-3.1-flash-image", pro: "gemini-3-pro-image" };
export const googleDisponible = () => Boolean(process.env.GOOGLE_API_KEY);
let apiGoogle = process.env.GOOGLE_IMAGE_API || null; // "interactions" | "generatecontent"

// Busca la última imagen en cualquier forma de respuesta de Google (Interactions o generateContent).
function imagenDe(json) {
  let ultima = null;
  const visitar = (o) => {
    if (!o || typeof o !== "object") return;
    if (Array.isArray(o)) return o.forEach(visitar);
    const d = (o.type === "image" && typeof o.data === "string" && o.data) || o.inlineData?.data || o.inline_data?.data || o.output_image?.data;
    if (typeof d === "string" && d.length > 100) ultima = d;
    for (const v of Object.values(o)) if (v && typeof v === "object") visitar(v);
  };
  visitar(json);
  return ultima;
}

async function llamarGoogle(url, body) {
  let res;
  try {
    res = await fetch(url, { method: "POST", headers: { "x-goog-api-key": process.env.GOOGLE_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body), signal: conTiempo(240e3) });
  } catch { throw new ErrorProveedor("Google", "sin conexión o tardó demasiado"); }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

export async function generarGoogle({ prompt, refs, modelo, aspecto = "16:9", resolucion }) {
  const model = process.env.GOOGLE_IMAGE_MODEL || MODELOS_GOOGLE[modelo] || MODELOS_GOOGLE.pro;
  const tam = resolucion || process.env.IMAGE_RESOLUTION || "1K";
  const intentos = apiGoogle === "generatecontent" ? ["generatecontent"] : apiGoogle === "interactions" ? ["interactions"] : ["interactions", "generatecontent"];
  let ultimoError = "sin respuesta";
  for (const api of intentos) {
    const { res, data } = api === "interactions"
      ? await llamarGoogle("https://generativelanguage.googleapis.com/v1beta/interactions", {
          model,
          input: [{ type: "text", text: prompt }, ...refs.map((r) => ({ type: "image", mime_type: r.mime, data: r.base64 }))],
          response_format: { type: "image", aspect_ratio: aspecto, image_size: tam, mime_type: "image/jpeg" },
        })
      : await llamarGoogle(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          contents: [{ role: "user", parts: [{ text: prompt }, ...refs.map((r) => ({ inline_data: { mime_type: r.mime, data: r.base64 } }))] }],
          generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: aspecto, imageSize: tam } },
        });
    const img = res.ok ? imagenDe(data) : null;
    if (img) { apiGoogle = api; return Buffer.from(img, "base64"); }
    const razon = data.error?.message || data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || `HTTP ${res.status}`;
    ultimoError = String(razon).slice(0, 200);
    // Errores del contenido o de la cuenta (seguridad, cuota, llave) no se arreglan cambiando de forma de llamar.
    if (res.ok || [401, 403, 429].includes(res.status) || /safety|blocked|quota|billing|permission/i.test(ultimoError)) break;
  }
  throw new ErrorProveedor("Google", ultimoError);
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
