// Transcripción del audio. Usa cualquier API compatible con OpenAI /audio/transcriptions
// (Groq es la más barata y rápida; también OpenAI). Sin TRANSCRIBE_API_KEY se omite.
import fs from "node:fs/promises";
import path from "node:path";

const URL_API = process.env.TRANSCRIBE_API_URL || "https://api.groq.com/openai/v1/audio/transcriptions";
const MODELO = process.env.TRANSCRIBE_MODEL || "whisper-large-v3-turbo";
export const transcripcionDisponible = () => Boolean(process.env.TRANSCRIBE_API_KEY);

export async function transcribir(partes, idioma) {
  const textos = [];
  for (const archivo of partes) {
    const fd = new FormData();
    fd.append("file", new Blob([await fs.readFile(archivo)], { type: "audio/mpeg" }), path.basename(archivo));
    fd.append("model", MODELO);
    if (idioma) fd.append("language", idioma);
    fd.append("response_format", "text");
    let res;
    for (let intento = 0; intento < 4; intento++) {
      res = await fetch(URL_API, { method: "POST", headers: { Authorization: `Bearer ${process.env.TRANSCRIBE_API_KEY}` }, body: fd, signal: AbortSignal.timeout(300e3) });
      if (res.status !== 429 && res.status < 500) break;
      await new Promise((r) => setTimeout(r, 5000 * (intento + 1)));
    }
    if (!res.ok) throw Object.assign(new Error(`La transcripción falló (${res.status}).`), { publico: true, reintentable: res.status >= 500 || res.status === 429 });
    textos.push((await res.text()).trim());
  }
  return textos.join("\n");
}
