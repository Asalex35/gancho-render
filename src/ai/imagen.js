// Generación de imagen con respaldo: intenta los proveedores en orden y salta al siguiente si uno falla.
// Orden por defecto: nanobanana (nanobananaapi.ai) → google (Gemini directo) → fal (Seedream 4).
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
  const pedido = (process.env.IMAGE_PROVIDERS || "nanobanana,google,fal").split(",").map((s) => s.trim()).filter((p) => PROVEEDORES[p]);
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
export async function generar({ prompt, refs, modelo, evitar = [], alCambiar }) {
  const candidatos = orden().filter((p) => !evitar.includes(p));
  if (!candidatos.length) throw Object.assign(new Error("No hay ningún proveedor de imagen disponible."), { publico: true });
  // Si todos están "saltados", se intenta igual con el primero (mejor intentar que fallar sin probar).
  const lista = candidatos.filter((p) => !abierto(p));
  const intentar = lista.length ? lista : candidatos.slice(0, 1);
  const errores = [];
  for (const [i, p] of intentar.entries()) {
    try {
      if (i > 0 && alCambiar) await alCambiar(p, errores.at(-1));
      if (p === "nanobanana") {
        const urls = refs.map((r) => r.url).filter(Boolean);
        return { proveedor: p, taskId: await nb.crearTarea({ modelo, prompt, imageUrls: urls.length === refs.length ? urls : [] }) };
      }
      const buffer = p === "google" ? await generarGoogle({ prompt, refs, modelo }) : await generarFal({ prompt, refs });
      return { proveedor: p, buffer };
    } catch (e) {
      registrarFalla(p);
      errores.push(e.message);
      console.warn(`[imagen] ${p} falló: ${e.message}`);
    }
  }
  throw Object.assign(new Error(`Ningún proveedor pudo hacer la imagen (${errores.join(" · ")}).`), { publico: true, reintentable: true });
}

export { registrarFalla };
