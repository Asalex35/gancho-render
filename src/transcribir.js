// Transcripción del audio del episodio.
// 1) ElevenLabs Scribe v2 (principal): texto + quién habla y cuándo (diarización incluida en el precio).
// 2) Respaldo: cualquier API compatible con OpenAI /audio/transcriptions (OpenAI, Groq…): solo texto.
import fs from "node:fs/promises";
import path from "node:path";
import { senal } from "./contexto.js";

const EL_KEY = () => process.env.ELEVENLABS_API_KEY;
const OA_KEY = () => process.env.TRANSCRIBE_API_KEY;
export const transcripcionDisponible = () => Boolean(EL_KEY() || OA_KEY());
const err = (m, reintentable) => Object.assign(new Error(m), { publico: true, reintentable });

async function conReintentos(fn) {
  let ultimo;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) { ultimo = e; if (!e.reintentable) throw e; await new Promise((r) => setTimeout(r, 5000 * (i + 1))); }
  }
  throw ultimo;
}

// Agrupa palabras seguidas del mismo hablante en frases: [{ inicio, fin, hablante, texto }]
function frasesDePalabras(palabras) {
  const letras = {};
  const etiqueta = (id) => (id ? (letras[id] ??= String.fromCharCode(65 + Object.keys(letras).length)) : null);
  const frases = [];
  for (const w of palabras) {
    if (w.type === "audio_event" || w.start == null) continue;
    const h = etiqueta(w.speaker_id);
    const ult = frases.at(-1);
    if (w.type === "spacing") { if (ult) ult.texto += w.text; continue; }
    if (ult && ult.hablante === h && w.start - ult.fin < 1.2) { ult.texto += w.text; ult.fin = w.end ?? w.start; }
    else frases.push({ inicio: w.start, fin: w.end ?? w.start, hablante: h, texto: w.text });
  }
  return frases.map((f) => ({ ...f, texto: f.texto.trim() })).filter((f) => f.texto);
}

async function elevenlabs(archivo, idioma) {
  const fd = new FormData();
  fd.append("model_id", process.env.ELEVENLABS_STT_MODEL || "scribe_v2");
  fd.append("file", new Blob([await fs.readFile(archivo)], { type: "audio/mpeg" }), path.basename(archivo));
  if (idioma) fd.append("language_code", idioma);
  fd.append("diarize", "true");
  fd.append("timestamps_granularity", "word");
  fd.append("tag_audio_events", "false");
  let res;
  try {
    res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": EL_KEY() }, body: fd, signal: senal(15 * 60e3) });
  } catch { throw err("No hubo conexión con ElevenLabs.", true); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw err(`ElevenLabs: ${body.detail?.message || body.detail || res.status}`.slice(0, 200), res.status === 429 || res.status >= 500);
  return { texto: body.text || "", frases: frasesDePalabras(body.words || []), proveedor: "elevenlabs" };
}

async function compatibleOpenAI(archivo, idioma) {
  const fd = new FormData();
  fd.append("file", new Blob([await fs.readFile(archivo)], { type: "audio/mpeg" }), path.basename(archivo));
  fd.append("model", process.env.TRANSCRIBE_MODEL || "whisper-large-v3");
  if (idioma) fd.append("language", idioma);
  fd.append("response_format", "text");
  let res;
  try {
    res = await fetch(process.env.TRANSCRIBE_API_URL || "https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: `Bearer ${OA_KEY()}` }, body: fd, signal: senal(10 * 60e3) });
  } catch { throw err("No hubo conexión con la transcripción.", true); }
  if (!res.ok) throw err(`La transcripción falló (${res.status}).`, res.status === 429 || res.status >= 500);
  return { texto: (await res.text()).trim(), frases: [], proveedor: "compatible" };
}

// archivo: un MP3 (máx. ~40 min). Devuelve { texto, frases, proveedor } con tiempos del audio.
export async function transcribir(archivo, idioma) {
  if (EL_KEY()) {
    try { return await conReintentos(() => elevenlabs(archivo, idioma)); }
    catch (e) { if (!OA_KEY()) throw e; console.warn("ElevenLabs falló, uso el respaldo:", e.message); }
  }
  return conReintentos(() => compatibleOpenAI(archivo, idioma));
}

// Texto con hablantes y minutos para Claude: "[A 12:03] ¿Dónde está Andrés?"
export function guionConHablantes(frases) {
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  return frases.map((f) => `[${f.hablante || "?"} ${mmss(f.inicio)}] ${f.texto}`).join("\n");
}
