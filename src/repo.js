// Lecturas y escrituras comunes en la base.
import { one, all, q } from "./db.js";
import { CANALES_SEMILLA } from "./ai/playbook.js";

export async function sembrarCanales() {
  for (const [id, c] of Object.entries(CANALES_SEMILLA)) {
    await q(`INSERT INTO canales (id, nombre, voz, descripcion_fija, disclaimer, hashtags_base, idioma, pais)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING`,
      [id, c.nombre, c.voz, c.descripcionFija, c.disclaimer, JSON.stringify(c.hashtagsBase), c.idioma, c.pais]);
  }
}

export const canal = (id) => one("SELECT * FROM canales WHERE id = $1", [id]);
export const canales = () => all("SELECT * FROM canales ORDER BY creado");

export async function episodio(id) {
  const ep = await one("SELECT * FROM episodios WHERE id = $1", [id]);
  if (!ep) return null;
  ep.propuestas = await all(
    `SELECT p.*, (SELECT count(*)::int FROM versiones v WHERE v.propuesta_id = p.id) AS n_versiones
     FROM propuestas p WHERE episodio_id = $1 AND NOT archivada ORDER BY slot`, [id]);
  return ep;
}

export const propuesta = (id) => one("SELECT * FROM propuestas WHERE id = $1", [id]);

export function tocarEpisodio(id) {
  return q("UPDATE episodios SET actualizado = now() WHERE id = $1", [id]);
}

export async function feedbackReciente(canalId, n = 12) {
  return (await all("SELECT titulo, objetivo, razones, comentario FROM feedback WHERE canal = $1 ORDER BY creado DESC LIMIT $2", [canalId, n])).reverse();
}

export async function sumarUso(usuario, tipo, n = 1) {
  const col = tipo === "imagenes" ? "imagenes" : "textos";
  await q(`INSERT INTO uso (usuario, ${col}) VALUES ($1, $2)
           ON CONFLICT (dia, usuario) DO UPDATE SET ${col} = uso.${col} + EXCLUDED.${col}`, [usuario, n]);
}
export async function usoHoy(usuario) {
  const u = await one("SELECT imagenes, textos FROM uso WHERE dia = current_date AND usuario = $1", [usuario]);
  const org = await one("SELECT coalesce(sum(imagenes),0)::int AS imagenes FROM uso WHERE dia = current_date");
  return { imagenes: u?.imagenes || 0, textos: u?.textos || 0, org: org.imagenes };
}

// Formato que consume la interfaz.
export function publicarEpisodio(ep) {
  const video = ep.video ? { ...ep.video, transcripcion: undefined, subtitulos: undefined, tieneTexto: Boolean(ep.video.transcripcion) } : null;
  return {
    ...ep,
    video,
    propuestas: (ep.propuestas || []).map((p) => ({
      id: p.id, slot: p.slot, version: p.version, ...p.data,
      imagen: { estado: p.imagen.estado, key: p.imagen.key, mini: p.imagen.mini, error: p.imagen.error, inicio: p.imagen.inicio, intentos: p.imagen.intentos, proveedor: p.imagen.proveedor },
      evaluacion: p.evaluacion, evaluando: p.evaluando, rehaciendo: p.rehaciendo, errorRehacer: p.error_rehacer,
      editadoAMano: p.editado, autoReintento: p.imagen.autoReintento || null, nVersiones: p.n_versiones || 0,
    })),
  };
}
