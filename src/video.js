// Lectura del video del episodio con ffmpeg: duración, audio para transcribir y cuadros para elegir caras.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import sharp from "sharp";

const N_CUADROS = 48;

function ffmpeg(args, { timeoutMs = 15 * 60e3 } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(ffmpegPath, ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err = (err + d).slice(-20000); });
    const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.on("close", (code) => { clearTimeout(t); code === 0 ? ok(err) : no(Object.assign(new Error(`ffmpeg falló (${code})`), { detalle: err.slice(-800) })); });
    p.on("error", no);
  });
}

export async function duracion(entrada) {
  // ffmpeg sin salida termina con error, pero imprime la duración en stderr.
  const err = await ffmpeg(["-i", entrada], { timeoutMs: 60e3 }).catch((e) => e.detalle || "");
  const m = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(err);
  if (!m) throw Object.assign(new Error("No pude leer el video. ¿Es un archivo de video válido?"), { publico: true });
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

export const carpetaTemporal = () => fs.mkdtemp(path.join(os.tmpdir(), "gancho-"));

// Audio comprimido en partes de 20 min (las APIs de transcripción aceptan ~25 MB por archivo).
export async function extraerAudio(entrada, dir) {
  await ffmpeg(["-i", entrada, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-f", "segment", "-segment_time", "1200", path.join(dir, "audio_%03d.mp3")]);
  return (await fs.readdir(dir)).filter((f) => f.startsWith("audio_")).sort().map((f) => path.join(dir, f));
}

// Cuadros repartidos en todo el episodio (sin el 3 % del inicio y del final: intro y créditos).
export async function extraerCuadros(entrada, segundos, dir, n = N_CUADROS) {
  const tiempos = Array.from({ length: n }, (_, i) => segundos * (0.03 + (0.94 * i) / (n - 1)));
  const salidas = [];
  for (let i = 0; i < tiempos.length; i += 4) {
    await Promise.all(tiempos.slice(i, i + 4).map(async (t, j) => {
      const out = path.join(dir, `cuadro_${String(i + j + 1).padStart(2, "0")}.jpg`);
      await ffmpeg(["-ss", t.toFixed(2), "-i", entrada, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", "-y", out], { timeoutMs: 120e3 })
        .then(() => salidas.push({ n: i + j + 1, t, archivo: out }))
        .catch(() => {});
    }));
  }
  return salidas.sort((a, b) => a.n - b.n);
}

// Hojas de contacto de 12 cuadros numerados para que Claude elija (más barato que mandar 48 imágenes).
export async function hojasDeContacto(cuadros) {
  const hojas = [];
  const W = 400, H = 225, COLS = 4;
  for (let i = 0; i < cuadros.length; i += 12) {
    const grupo = cuadros.slice(i, i + 12);
    const filas = Math.ceil(grupo.length / COLS);
    const capas = await Promise.all(grupo.map(async (c, k) => {
      const etiqueta = Buffer.from(`<svg width="${W}" height="${H}"><rect x="0" y="0" width="58" height="34" rx="6" fill="black" opacity=".8"/>
        <text x="29" y="24" font-family="Arial" font-size="22" font-weight="bold" fill="#ffd84d" text-anchor="middle">${c.n}</text></svg>`);
      const img = await sharp(c.archivo).resize(W, H, { fit: "cover" }).composite([{ input: etiqueta, left: 0, top: 0 }]).jpeg().toBuffer();
      return { input: img, left: (k % COLS) * W, top: Math.floor(k / COLS) * H };
    }));
    const buf = await sharp({ create: { width: COLS * W, height: filas * H, channels: 3, background: "#000" } }).composite(capas).jpeg({ quality: 80 }).toBuffer();
    hojas.push({ desde: grupo[0].n, hasta: grupo.at(-1).n, base64: buf.toString("base64") });
  }
  return hojas;
}

// Subtítulos SRT/VTT a texto plano.
export function textoDeSubtitulos(s) {
  return String(s || "")
    .replace(/^WEBVTT.*$/m, "")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^\d+$/.test(l.trim()) && !/-->/.test(l))
    .map((l) => l.replace(/<[^>]+>/g, "").trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
