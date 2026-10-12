// Portadas de otros canales para la vista previa "Así se ve en YouTube".
// Sin API key: links de video → oEmbed (título y canal); links de canal → RSS público (últimos 15 videos con vistas).
import { senal } from "./contexto.js";

const UA = { "User-Agent": "Mozilla/5.0 (Gancho)", "Accept-Language": "es-MX,es;q=0.9" };
const ID_VIDEO = /(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/;
const CANAL = /youtube\.com\/(@[\w.-]{2,60}|channel\/UC[\w-]{22}|c\/[\w.-]{2,60}|user\/[\w.-]{2,60})/;

async function texto(url) {
  const res = await fetch(url, { headers: UA, signal: senal(10000), redirect: "follow" });
  if (!res.ok) throw new Error(`YouTube respondió ${res.status}`);
  return res.text();
}

async function video(id) {
  const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
  const d = JSON.parse(await texto(url));
  return { video_id: id, titulo: String(d.title || "").slice(0, 200), autor: String(d.author_name || "").slice(0, 100), vistas: null, publicado: null, duracion: null };
}

const desescapar = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

async function canal(ruta) {
  let id = ruta.startsWith("channel/") ? ruta.slice(8) : null;
  if (!id) {
    const html = await texto(`https://www.youtube.com/${ruta}`);
    id = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/)?.[1] || html.match(/"channelId":"(UC[\w-]{22})"/)?.[1];
    if (!id) throw new Error("No encontré ese canal");
  }
  const xml = await texto(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
  const autor = desescapar(xml.match(/<author>\s*<name>([^<]*)<\/name>/)?.[1] || "");
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    video_id: e.match(/<yt:videoId>([\w-]{11})<\/yt:videoId>/)?.[1],
    titulo: desescapar(e.match(/<title>([^<]*)<\/title>/)?.[1] || "").slice(0, 200),
    autor: autor.slice(0, 100),
    vistas: Number(e.match(/<media:statistics views="(\d+)"/)?.[1]) || null,
    publicado: e.match(/<published>([^<]+)<\/published>/)?.[1] || null,
    duracion: null,
  })).filter((v) => v.video_id && v.titulo);
}

// ---------- Con YOUTUBE_API_KEY: vistas, duración, búsquedas y tendencias reales ----------
// Cuota diaria gratis: 10,000 unidades. Búsqueda = 100, detalles/tendencias = 1. Las búsquedas se guardan 24 h.
export const apiDisponible = () => Boolean(process.env.YOUTUBE_API_KEY);
async function yt(ruta, params) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${ruta}`);
  for (const [k, v] of Object.entries({ ...params, key: process.env.YOUTUBE_API_KEY })) u.searchParams.set(k, v);
  const res = await fetch(u, { signal: senal(10000) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(`YouTube API: ${d.error?.message || res.status}`), { publico: true });
  return d;
}
function duracion(iso) {
  const [, h = 0, m = 0, s = 0] = String(iso || "").match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/) || [];
  const dd = (n) => String(n).padStart(2, "0");
  return iso ? (Number(h) ? `${h}:${dd(m)}:${dd(s)}` : `${m}:${dd(s)}`) : null;
}
const aVideo = (v) => ({ video_id: v.id, titulo: v.snippet.title.slice(0, 200), autor: v.snippet.channelTitle.slice(0, 100),
  vistas: Number(v.statistics?.viewCount) || null, publicado: v.snippet.publishedAt, duracion: duracion(v.contentDetails?.duration) });
async function detalles(ids) {
  if (!ids.length) return [];
  const d = await yt("videos", { part: "snippet,statistics,contentDetails", id: ids.slice(0, 50).join(",") });
  return (d.items || []).map(aVideo);
}
const cache = new Map();
async function guardado(llave, fn) {
  const c = cache.get(llave);
  if (c && Date.now() - c.t < 24 * 3600e3) return c.v;
  const v = await fn();
  cache.set(llave, { v, t: Date.now() });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  return v;
}
export const buscar = (texto, region = "MX") => guardado(`b|${region}|${texto.toLowerCase()}`, async () => {
  const d = await yt("search", { part: "id", q: texto, type: "video", maxResults: 15, regionCode: region, relevanceLanguage: "es", safeSearch: "moderate" });
  return detalles((d.items || []).map((i) => i.id.videoId).filter(Boolean));
});
export const tendencias = (region = "MX") => guardado(`t|${region}`, async () => {
  const d = await yt("videos", { part: "snippet,statistics,contentDetails", chart: "mostPopular", regionCode: region, maxResults: 30 });
  return (d.items || []).map(aVideo);
});

// Recibe texto con links (uno por línea o separados por espacios). Devuelve { videos, fallidos }.
export async function leerLinks(entrada) {
  const links = String(entrada || "").split(/[\s,]+/).filter(Boolean).slice(0, 30);
  const videos = [], fallidos = [];
  for (const l of links) {
    try {
      const v = l.match(ID_VIDEO)?.[1];
      if (v) { videos.push(...(apiDisponible() ? await detalles([v]) : [await video(v)])); continue; }
      const c = l.match(CANAL)?.[1];
      if (c) { videos.push(...(await canal(c))); continue; }
      fallidos.push(l);
    } catch { fallidos.push(l); }
  }
  return { videos, fallidos };
}
