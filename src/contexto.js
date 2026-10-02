// Contexto del trabajo en curso: permite cancelar llamadas a Claude / Nano Banana / descargas
// cuando pg-boss da por vencido un trabajo, sin pasar la señal por todas las funciones.
import { AsyncLocalStorage } from "node:async_hooks";

export const als = new AsyncLocalStorage();

// Señal del trabajo actual combinada con un tiempo máximo.
export function senal(ms) {
  const s = als.getStore()?.signal;
  const t = AbortSignal.timeout(ms);
  return s ? AbortSignal.any([s, t]) : t;
}

// Semáforo simple: limita cuántas llamadas a un servicio corren a la vez en este proceso.
export function semaforo(max) {
  let activos = 0;
  const cola = [];
  // Al terminar, el turno pasa directo al siguiente en espera (sin liberar el lugar), así nunca se pasa del límite.
  const soltar = () => { const sig = cola.shift(); if (sig) sig(); else activos--; };
  return async (fn) => {
    if (activos >= max) await new Promise((r) => cola.push(r));
    else activos++;
    try { return await fn(); } finally { soltar(); }
  };
}
