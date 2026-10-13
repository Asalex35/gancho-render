// Avisos al equipo por webhook (Slack, Google Chat o Discord). Si falla, no detiene nada.
import { config } from "./config.js";

export async function notificar(canal, texto, enlace) {
  const url = canal?.webhook_url || process.env.NOTIFY_WEBHOOK_URL;
  if (!url || !/^https:\/\/(hooks\.slack\.com|chat\.googleapis\.com|discord\.com|discordapp\.com)\//.test(url)) return;
  // Un título no debe poder hacer @everyone / <!channel>.
  const limpio = String(texto).replace(/<!(channel|here|everyone)>/gi, "").replace(/@(everyone|here|channel)/gi, "@\u200b$1");
  const mensaje = enlace ? `${limpio}\n${config.publicBaseUrl}/${enlace}` : limpio;
  try {
    // "text" lo leen Slack y Google Chat; "content" lo lee Discord.
    await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: mensaje, content: mensaje }), signal: AbortSignal.timeout(10000), redirect: "error" });
  } catch (e) {
    console.warn("No se pudo mandar el aviso:", e.message);
  }
}
