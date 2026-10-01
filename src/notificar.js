// Avisos al equipo por webhook (Slack, Google Chat o Discord). Si falla, no detiene nada.
import { config } from "./config.js";

export async function notificar(canal, texto, enlace) {
  const url = canal?.webhook_url || process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !/^https:\/\//.test(url)) return;
  const mensaje = enlace ? `${texto}\n${config.publicBaseUrl}/${enlace}` : texto;
  try {
    // "text" lo leen Slack y Google Chat; "content" lo lee Discord.
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: mensaje, content: mensaje }), signal: AbortSignal.timeout(10000) });
  } catch (e) {
    console.warn("No se pudo mandar el aviso:", e.message);
  }
}
