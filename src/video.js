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

// ---------- Transcripción limitada (máx. N minutos por episodio) ----------
// Si el episodio es más largo, se toma el inicio, la mitad y el final: ahí están el planteamiento, el giro y el desenlace.
export function planTranscripcion(segundos, maxMin = Number(process.env.TRANSCRIBE_MAX_MINUTES || 40)) {
  const max = maxMin * 60;
  if (segundos <= max) return [{ desde: 0, dur: segundos }];
  const ini = max * 0.5, mid = max * 0.25, fin = max * 0.25;
  return [
    { desde: 0, dur: ini },
    { desde: segundos / 2 - mid / 2, dur: mid },
    { desde: segundos - fin, dur: fin },
  ];
}

// Un solo MP3 con los tramos pegados (así el proveedor reconoce a los mismos hablantes en todo el audio).
export async function audioDeTramos(entrada, tramos, dir) {
  const partes = [];
  for (const [i, t] of tramos.entries()) {
    const out = path.join(dir, `tramo_${i}.mp3`);
    await ffmpeg(["-ss", t.desde.toFixed(2), "-t", t.dur.toFixed(2), "-i", entrada, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", "-y", out]);
    partes.push(out);
  }
  if (partes.length === 1) return partes[0];
  const lista = path.join(dir, "tramos.txt");
  await fs.writeFile(lista, partes.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));
  const unido = path.join(dir, "audio.mp3");
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lista, "-c", "copy", "-y", unido]);
  return unido;
}

// Convierte un tiempo del audio pegado al tiempo real del video.
export function tiempoReal(t, tramos) {
  let acumulado = 0;
  for (const tr of tramos) {
    if (t < acumulado + tr.dur) return tr.desde + (t - acumulado);
    acumulado += tr.dur;
  }
  const u = tramos.at(-1);
  return u.desde + u.dur;
}

// ---------- Ventanas para el detector de caras (≈5 min de video en total) ----------
// Con hablantes: ventanas donde habla cada personaje importante. Sin hablantes: ventanas repartidas en el episodio.
export function planCaras(segundos, frases, { totalSeg = Number(process.env.FACE_SCAN_SECONDS || 300), maxHablantes = 5 } = {}) {
  const ventanas = [];
  const porHablante = {};
  for (const f of frases || []) if (f.hablante) (porHablante[f.hablante] ??= []).push(f);
  const principales = Object.entries(porHablante)
    .map(([h, fs]) => [h, fs, fs.reduce((s, f) => s + (f.fin - f.inicio), 0)])
    .filter(([, , dur]) => dur >= 15).sort((a, b) => b[2] - a[2]).slice(0, maxHablantes);
  if (principales.length) {
    const cupo = totalSeg / principales.length;
    for (const [h, fs] of principales) {
      const largas = fs.filter((f) => f.fin - f.inicio >= 2.5);
      const elegidas = repartir(largas.length ? largas : fs, Math.max(3, Math.round(cupo / 6)));
      let usado = 0;
      for (const f of elegidas) {
        const dur = Math.min(8, f.fin - f.inicio, cupo - usado);
        if (dur < 1) break;
        ventanas.push({ desde: f.inicio, dur, hablante: h });
        usado += dur;
      }
    }
  }
  // Si con los hablantes no se llena ni la mitad del tiempo, se completa con ventanas repartidas en el episodio.
  const usado = ventanas.reduce((s, v) => s + v.dur, 0);
  if (usado < totalSeg * 0.5) {
    const resto = totalSeg - usado, n = Math.max(2, Math.round(resto / 30)), dur = resto / n;
    for (let i = 0; i < n; i++) ventanas.push({ desde: segundos * (0.05 + (0.9 * i) / n), dur: Math.min(dur, segundos / n), hablante: null });
  }
  return ventanas.map((v) => ({ ...v, desde: Math.max(0, Math.min(v.desde, segundos - v.dur)) }));
}
function repartir(lista, n) {
  if (lista.length <= n) return lista;
  return Array.from({ length: n }, (_, i) => lista[Math.floor((i * lista.length) / n)]);
}

// Extrae cuadros de una ventana (1 por segundo, o al menos 2).
export async function cuadrosDeVentana(entrada, v, dir, prefijo) {
  const fps = v.dur < 3 ? 2 : 1;
  await ffmpeg(["-ss", v.desde.toFixed(2), "-t", v.dur.toFixed(2), "-i", entrada, "-vf", `fps=${fps},scale=1280:-2`, "-q:v", "3", "-y", path.join(dir, `${prefijo}_%03d.jpg`)], { timeoutMs: 120e3 });
  const archivos = (await fs.readdir(dir)).filter((f) => f.startsWith(`${prefijo}_`)).sort();
  return archivos.map((f, i) => ({ archivo: path.join(dir, f), t: v.desde + i / fps, hablante: v.hablante }));
}

// Hoja con recortes de caras numerados (C1, C2…) y la etiqueta del hablante para que Claude decida quién es quién.
export async function hojaDeCaras(candidatos) {
  const hojas = [];
  const T = 220, COLS = 6;
  for (let i = 0; i < candidatos.length; i += 24) {
    const grupo = candidatos.slice(i, i + 24);
    const filas = Math.ceil(grupo.length / COLS);
    const capas = await Promise.all(grupo.map(async (c, k) => {
      const texto = `C${c.n}${c.hablante ? ` · ${c.hablante}` : ""}`;
      const etiqueta = Buffer.from(`<svg width="${T}" height="${T}"><rect x="0" y="0" width="${18 + texto.length * 11}" height="30" rx="6" fill="black" opacity=".8"/>
        <text x="8" y="21" font-family="Arial" font-size="18" font-weight="bold" fill="#ffd84d">${texto}</text></svg>`);
      const img = await sharp(c.rostro).resize(T, T).composite([{ input: etiqueta, left: 0, top: 0 }]).jpeg().toBuffer();
      return { input: img, left: (k % COLS) * T, top: Math.floor(k / COLS) * T };
    }));
    const buf = await sharp({ create: { width: COLS * T, height: filas * T, channels: 3, background: "#000" } }).composite(capas).jpeg({ quality: 82 }).toBuffer();
    hojas.push({ desde: grupo[0].n, hasta: grupo.at(-1).n, base64: buf.toString("base64") });
  }
  return hojas;
}
