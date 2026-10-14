// Generación de imagen con respaldo: intenta los proveedores en orden y salta al siguiente si uno falla.
// Orden por defecto: google (API oficial de Gemini) → nanobanana (nanobananaapi.ai) → fal (Seedream 4): tres empresas distintas,
// así una caída de cualquiera no detiene las portadas.
// Un "cortacircuitos" evita insistir con un proveedor caído: tras 3 fallas en 5 min se salta 5 min.
import * as nb from "./nanobanana.js";
import { generarGoogle, generarFal, googleDisponible, falDisponible } from "./respaldos.js";
import { config } from "../config.js";

export const PROVEEDORES = {
  nanobanana: { nombre: "Nano Banana", disponible: () => Boolean(config.nanoBananaKey), async: true },
  google: { nombre: "Google Gemini", disponible: googleDisponible, async: false },
  fal: { nombre: "Seedream", disponible: falDisponible, async: false },
};

export function orden() {
  const pedido = (process.env.IMAGE_PROVIDERS || "google,nanobanana,fal").split(",").map((s) => s.trim()).filter((p) => PROVEEDORES[p]);
  return pedido.filter((p) => PROVEEDORES[p].disponible());
}

const fallas = new Map(); // proveedor -> [timestamps]
const VENTANA = 5 * 60e3;
function registrarFalla(p) {
  const ts = (fallas.get(p) || []).filter((t) => t > Date.now() - VENTANA);
  ts.push(Date.now());
  fallas.set(p, ts);
}
const abierto = (p) => (fallas.get(p) || []).filter((t) => t > Date.now() - VENTANA).length >= 3;
export function estado() {
  return Object.fromEntries(orden().map((p) => [p, abierto(p) ? "saltado" : "ok"]));
}

// refs: [{ url?, base64, mime }] en el mismo orden que menciona el prompt.
// Devuelve { proveedor, taskId } (asíncrono, hay que consultar) o { proveedor, buffer } (ya lista).
export async function generar({ prompt, refs, modelo, evitar = [], alCambiar, aspecto = "16:9", resolucion }) {
  const candidatos = orden().filter((p) => !evitar.includes(p));
  if (!candidatos.length) throw Object.assign(new Error("No hay ningún proveedor de imagen disponible."), { publico: true });
  // Si todos están "saltados", se intenta igual con el primero (mejor intentar que fallar sin probar).
  const lista = candidatos.filter((p) => !abierto(p));
  const intentar = lista.length ? lista : candidatos.slice(0, 1);
  const errores = [];
  for (const [i, p] of intentar.entries()) {
    try {
      if (i > 0 && alCambiar) await alCambiar(p, errores.at(-1)?.message);
      if (p === "nanobanana") {
        const urls = refs.map((r) => r.url).filter(Boolean);
        return { proveedor: p, taskId: await nb.crearTarea({ modelo, prompt, imageUrls: urls.length === refs.length ? urls : [], aspecto, resolucion }) };
      }
      const buffer = p === "google" ? await generarGoogle({ prompt, refs, modelo, aspecto, resolucion }) : await generarFal({ prompt, refs, aspecto });
      return { proveedor: p, buffer };
    } catch (e) {
      registrarFalla(p);
      errores.push(e);
      console.warn(`[imagen] ${p} falló: ${e.message}`);
    }
  }
  // Sin créditos o llave inválida no se arregla reintentando; una caída temporal sí.
  const reintentable = errores.some((e) => e.reintentable !== false);
  const texto = errores.length === 1 && errores[0].publico ? errores[0].message : `Ningún proveedor pudo hacer la imagen (${errores.map((e) => e.message).join(" · ")}).`;
  throw Object.assign(new Error(texto), { publico: true, reintentable });
}

export { registrarFalla };

// Costo aproximado por imagen (US$) según el proveedor que va primero. Precios públicos oct 2026.
const USD = { google: { pro: 0.134, nb2: 0.067 }, nanobanana: { pro: 0.09, nb2: 0.06 }, fal: { pro: 0.15, nb2: 0.08 } };
export const principal = () => orden()[0] || "nanobanana";
export const usdPorImagen = (modelo = "pro") => Number(process.env.USD_POR_IMAGEN) || USD[principal()]?.[modelo] || 0.134;
