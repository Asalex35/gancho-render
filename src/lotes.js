// Carga masiva: interpreta lo que el equipo pega desde Google Sheets / Excel (o un CSV).
import Papa from "papaparse";
import { all } from "./db.js";

export const normal = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

const COLUMNAS = {
  nombre: ["nombre", "titulo", "titulo interno", "episodio", "capitulo", "id", "name", "title", "episode", "nome", "episodio"],
  canal: ["canal", "channel"],
  sinopsis: ["sinopsis", "historia", "resumen", "trama", "descripcion", "synopsis", "story", "summary", "plot", "sinopse", "resumo", "enredo"],
  giro: ["giro", "giro principal", "traicion", "conflicto", "twist", "conflict", "reviravolta", "conflito"],
  momento: ["momento", "momento cumbre", "momento mas fuerte", "escena", "escena portada", "portada", "key moment", "thumbnail scene", "scene", "cena", "momento chave"],
  desenlace: ["desenlace", "final", "como termina", "ending", "desfecho"],
  escenario: ["escenario", "lugar", "locacion", "setting", "location", "cenario", "local"],
  notas: ["notas", "notas para gancho", "comentarios", "notes", "observacoes"],
  actores: ["actores", "cast", "reparto", "elenco", "actors", "atores"],
};
const MAPA = Object.fromEntries(Object.entries(COLUMNAS).flatMap(([k, vs]) => vs.map((v) => [v, k])));

export const PLANTILLA = [
  ["nombre", "sinopsis", "giro", "momento", "desenlace", "escenario", "actores", "notas"],
  ["La boda de Valeria", "Valeria trabaja doble turno para pagar su boda. Su hermana Camila se acerca a su novio Andrés...", "Su hermana se fuga con el novio el día de la boda", "Valeria llorando en el piso de la iglesia", "Valeria abre su propio negocio y Camila regresa a pedir perdón", "Iglesia de pueblo", "Valeria=Nombre Actriz; Camila=Nombre Actriz 2; Andrés=Nombre Actor", ""],
  ["El taxista", "Un taxista descubre que su esposa lo engaña con su jefe...", "", "", "", "", "", "Solo la sinopsis también funciona"],
];

export async function interpretar(texto, canales) {
  const parsed = Papa.parse(String(texto || "").trim(), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => MAPA[normal(h)] || `_${normal(h)}` });
  const desconocidas = (parsed.meta.fields || []).filter((f) => f.startsWith("_")).map((f) => f.slice(1));
  if (!parsed.meta.fields?.includes("sinopsis")) {
    return { error: "No encontré la columna \"sinopsis\". La primera fila debe tener los nombres de las columnas (usa la plantilla).", filas: [] };
  }
  const actores = await all("SELECT id, nombre, jsonb_array_length(fotos) AS n FROM actores");
  const buscarActor = (nombre) => {
    const n = normal(nombre);
    return actores.find((a) => normal(a.nombre) === n) || actores.find((a) => normal(a.nombre).startsWith(n) || n.startsWith(normal(a.nombre)));
  };
  const canalDe = (v) => {
    const n = normal(v);
    return n ? canales.find((c) => normal(c.id) === n || normal(c.nombre) === n)?.id || null : null;
  };

  const filas = parsed.data.map((r, i) => {
    const errores = [], avisos = [];
    const sinopsis = String(r.sinopsis || "").trim();
    if (!sinopsis) errores.push("Falta la sinopsis");
    else if (sinopsis.length < 80) avisos.push("Sinopsis muy corta: las propuestas saldrán genéricas");
    let canal = null;
    if (r.canal) { canal = canalDe(r.canal); if (!canal) avisos.push(`No conozco el canal "${r.canal}"; uso el del lote`); }
    const reparto = String(r.actores || "").split(/[;\n]/).map((s) => s.trim()).filter(Boolean).map((par) => {
      const [personaje, actor] = par.split(/[=:]/).map((s) => s?.trim());
      if (!personaje) return null;
      const a = actor ? buscarActor(actor) : null;
      if (actor && !a) avisos.push(`"${actor}" no está en la biblioteca de actores`);
      else if (a && !a.n) avisos.push(`${a.nombre} no tiene fotos`);
      return { personaje, actorNombre: a?.nombre || actor || null, actorId: a?.id || null };
    }).filter(Boolean);
    const faltan = ["giro", "momento", "desenlace"].filter((k) => !String(r[k] || "").trim());
    if (sinopsis && faltan.length) avisos.push(`Claude deducirá: ${faltan.join(", ")}`);
    return {
      fila: i + 2,
      nombre: String(r.nombre || "").trim().slice(0, 120) || sinopsis.slice(0, 60),
      canal,
      brief: {
        sinopsis: sinopsis.slice(0, 4000),
        giro: String(r.giro || "").trim().slice(0, 600),
        momento: String(r.momento || "").trim().slice(0, 600),
        desenlace: String(r.desenlace || "").trim().slice(0, 600),
        escenario: String(r.escenario || "").trim().slice(0, 200),
        notas: String(r.notas || "").trim().slice(0, 600),
      },
      reparto,
      errores, avisos,
    };
  });
  return { filas, desconocidas, erroresCSV: parsed.errors.slice(0, 5).map((e) => `Fila ${e.row + 2}: ${e.message}`) };
}
