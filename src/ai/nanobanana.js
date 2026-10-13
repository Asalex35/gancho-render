// Cliente de nanobananaapi.ai — https://docs.nanobananaapi.ai
import { config } from "../config.js";
import { senal } from "../contexto.js";

const BASE = "https://api.nanobananaapi.ai/api/v1";

export class ErrorNB extends Error {
  constructor(msg, { reintentable = false, code } = {}) { super(msg); this.publico = true; this.reintentable = reintentable; this.code = code; }
}

async function pedir(path, init = {}) {
  let res;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { Authorization: `Bearer ${config.nanoBananaKey}`, "Content-Type": "application/json" },
      signal: senal(30000),
    });
  } catch {
    throw new ErrorNB("No hubo conexión con Nano Banana.", { reintentable: true });
  }
  const body = await res.json().catch(() => ({}));
  const code = body.code || res.status;
  if (res.ok && code === 200) return body.data;
  if (code === 402) throw new ErrorNB("Ya no hay créditos en Nano Banana.", { code });
  if (code === 401) throw new ErrorNB("La API key de Nano Banana no es válida.", { code });
  if (code === 429 || code === 455 || code >= 500) throw new ErrorNB("Nano Banana está saturado; se reintentará.", { reintentable: true, code });
  throw new ErrorNB(`Nano Banana rechazó la petición (${body.msg || body.message || code}).`, { code });
}

export const MODELOS = {
  nb2: { nombre: "Nano Banana 2", ruta: "/nanobanana/generate-2", maxRefs: 14 },
  pro: { nombre: "Nano Banana Pro", ruta: "/nanobanana/generate-pro", maxRefs: 8 },
};

export async function crearTarea({ modelo = "nb2", prompt, imageUrls = [], aspecto = "16:9", resolucion }) {
  if (config.mockImages) return `mock_${Date.now()}_${Math.random().toString(36).slice(2)}|${prompt.slice(0, 120)}`;
  const m = MODELOS[modelo] || MODELOS.nb2;
  const body = {
    prompt: prompt.slice(0, 19000),
    imageUrls: imageUrls.slice(0, m.maxRefs),
    aspectRatio: aspecto,
    // YouTube muestra la portada a 1280x720 como máximo: 1K (1376x768) alcanza y se genera más rápido que 2K o 4K.
    resolution: resolucion || (modelo === "pro" ? (process.env.PRO_RESOLUTION || "1K") : config.imageResolution),
  };
  if (modelo === "nb2") body.outputFormat = "jpg";
  // Pro exige callback. Solo lo usamos como aviso; el estado real se consulta con la cola.
  if (modelo === "pro") body.callBackUrl = config.refsPublicas ? `${config.publicBaseUrl}/api/nb-callback/${config.callbackSecret}` : "https://example.com/sin-callback";
  const data = await pedir(m.ruta, { method: "POST", body: JSON.stringify(body) });
  return data.taskId;
}

// { estado: "generando" | "lista" | "error", url?, error? }
export async function consultarTarea(taskId) {
  if (taskId.startsWith("mock_")) return { estado: "lista", buffer: await imagenDePrueba(taskId.split("|")[1] || "") };
  const d = await pedir(`/nanobanana/record-info?taskId=${encodeURIComponent(taskId)}`);
  if (d.successFlag === 1) return { estado: "lista", url: d.response?.resultImageUrl || d.response?.originImageUrl };
  if (d.successFlag === 2 || d.successFlag === 3) return { estado: "error", error: d.errorMessage || "La imagen no se pudo generar." };
  return { estado: "generando" };
}

// Modo de prueba (NANOBANANA_MOCK=1): imagen falsa, no gasta créditos. Sirve para probar lotes grandes.
async function imagenDePrueba(texto) {
  const { default: sharp } = await import("sharp");
  const tono = Math.floor(Math.random() * 360);
  const esc = (t) => t.replace(/[<>&"]/g, "");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1376" height="768"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${tono},60%,35%)"/><stop offset="1" stop-color="hsl(${(tono + 60) % 360},60%,15%)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/><text x="60" y="380" font-family="Arial" font-size="64" font-weight="bold" fill="white">PORTADA DE PRUEBA</text>
    <text x="60" y="450" font-family="Arial" font-size="26" fill="white" opacity=".8">${esc(texto.slice(0, 90))}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 80 }).toBuffer();
}

// Para mostrar en pantalla: nunca bloquea más de 5 s y recuerda también las fallas por 30 s.
let cacheCreditos = { v: null, t: 0 };
// Para decidir si se gasta (p. ej. repintar): { espera: 15000, fresco: true }.
export async function creditos({ espera = 5000, fresco = false } = {}) {
  if (!fresco && Date.now() - cacheCreditos.t < 30e3) return cacheCreditos.v;
  let v = null;
  try {
    const res = await fetch(`${BASE}/common/credit`, { headers: { Authorization: `Bearer ${config.nanoBananaKey}` }, signal: AbortSignal.timeout(espera) });
    const body = await res.json();
    if (body.code === 200) v = body.data;
  } catch {}
  cacheCreditos = { v, t: Date.now() };
  return v;
}
