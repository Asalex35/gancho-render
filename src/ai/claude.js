import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PLAYBOOK } from "./playbook.js";
import { config } from "../config.js";

const client = new Anthropic({ apiKey: config.anthropicKey, maxRetries: 4 });

// ---------- Esquemas ----------
const Calificacion = z.object({
  total: z.number().int().describe("0-100, probabilidad estimada de que funcione"),
  tabu: z.number().int().describe("1-10"),
  especificidad: z.number().int().describe("1-10"),
  misterio: z.number().int().describe("1-10"),
  claridad_visual: z.number().int().describe("1-10"),
});
const Propuesta = z.object({
  titulo: z.string(),
  formula: z.enum(["A", "B", "C", "D", "Libre"]),
  composicion: z.enum(["Triangulo", "Amenaza", "Victima sola", "Otra"]),
  concepto: z.string().describe("Qué se ve en la portada, en español, 1-2 frases"),
  personajes_en_portada: z.array(z.string()).describe("Nombres de personaje EXACTOS del cast que aparecen en la imagen"),
  prompt_imagen: z.string().describe("Prompt en inglés para Nano Banana, detallado, refiriéndose a los personajes por su nombre"),
  calificacion: Calificacion,
  porque_funciona: z.array(z.string()).describe("3 razones, máximo 12 palabras cada una"),
  riesgo: z.string().describe("El punto débil principal, máximo 15 palabras"),
});
const Gancho = z.object({ transgresion: z.string(), testigo: z.string(), objeto: z.string(), escenario: z.string(), final_oculto: z.string() });
const RespuestaPropuestas = z.object({ gancho: Gancho, propuestas: z.array(Propuesta) });
const Evaluacion = z.object({
  calificacion_final: z.number().int().describe("0-100"),
  porque_funciona: z.array(z.string()),
  problemas: z.array(z.string()),
  caras_coinciden: z.enum(["si", "parcial", "no", "sin_referencia"]),
  tiene_texto: z.boolean(),
  aprobada: z.boolean(),
});
const Paquete = z.object({
  descripcion_gancho: z.string().describe("2 líneas sin spoiler, lo que se ve antes de 'ver más'"),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
  titulos_alternos: z.array(z.string()).describe("2 variantes del título elegido para prueba A/B"),
});
const Brief = z.object({
  giro: z.string(), momento: z.string(), desenlace: z.string(), escenario: z.string(),
  personajes: z.array(z.object({
    personaje: z.string(), edad: z.string(),
    rol: z.enum(["transgresor", "victima", "testigo", "villano", "otro"]),
    vestuario: z.string(),
  })),
});

// ---------- Llamada base ----------
// El playbook va en el system con caché: en lotes grandes se cobra una sola vez cada 5 min.
const SYSTEM = [{
  type: "text",
  text: `Eres el estratega de portadas y títulos de Prismáticoos para YouTube. Escribes en español de México. Sigues este playbook al pie de la letra:\n${PLAYBOOK}`,
  cache_control: { type: "ephemeral" },
}];

export class ErrorIA extends Error {
  constructor(msg, { reintentable = false } = {}) { super(msg); this.publico = true; this.reintentable = reintentable; }
}

async function llamar({ content, schema, effort = "medium", maxTokens = 16000 }) {
  const fmt = zodOutputFormat(schema);
  let res;
  try {
    res = await client.beta.messages.create({
      model: config.claudeModel,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort, format: { type: fmt.type, schema: fmt.schema } },
      messages: [{ role: "user", content }],
    });
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
      throw new ErrorIA("Claude está saturado; se reintentará.", { reintentable: true });
    }
    if (e instanceof Anthropic.AuthenticationError) throw new ErrorIA("La API key de Claude no es válida.");
    throw e;
  }
  if (res.stop_reason === "refusal") throw new ErrorIA("Claude no quiso generar esto. Revisa que el brief no tenga contenido con menores o violencia explícita.");
  if (res.stop_reason === "max_tokens") throw new ErrorIA("La respuesta de Claude se cortó.", { reintentable: true });
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return fmt.parse(text);
}

function describirEpisodio(ep, canal) {
  const b = ep.brief;
  const cast = (ep.cast || []).map((c) =>
    `- ${c.personaje} (${c.edad || "edad no indicada"}), rol: ${c.rol}, vestuario: ${c.vestuario || "libre"}, actor: ${c.actorNombre || "sin asignar"}`).join("\n");
  return `CANAL: ${canal.nombre}. Voz del canal: ${canal.voz}

SINOPSIS: ${b.sinopsis}
GIRO PRINCIPAL: ${b.giro || "(dedúcelo)"}
MOMENTO CUMBRE: ${b.momento || "(dedúcelo)"}
DESENLACE (no revelar nunca): ${b.desenlace || "(desconocido)"}
ESCENARIO: ${b.escenario || "libre"}
NOTAS DEL EQUIPO: ${b.notas || "ninguna"}

CAST:
${cast || "(sin cast definido)"}`;
}

function describirFeedback(fb) {
  if (!fb?.length) return "";
  return `\n\nLO QUE AL EQUIPO NO LE HA GUSTADO ANTES EN ESTE CANAL (evítalo):\n${fb
    .map((f) => `- "${f.titulo}" (${f.objetivo}): ${[...(f.razones || []), f.comentario].filter(Boolean).join("; ")}`).join("\n")}`;
}

// ---------- Funciones ----------

// Para el modo masivo: con solo la sinopsis, deduce giro, momento, desenlace y personajes.
export async function completarBrief(ep, canal) {
  const content = `${describirEpisodio(ep, canal)}

TAREA: Completa el brief. Deduce el giro principal, el momento más fuerte para la portada, el desenlace y el escenario.
Lista los personajes importantes (máximo 4) con edad aproximada, rol en la historia y vestuario visual.
Si el cast ya trae personajes, respeta sus nombres exactos.`;
  return llamar({ content, schema: Brief, effort: "low", maxTokens: 6000 });
}

export async function generarPropuestas(ep, canal, feedback) {
  const content = `${describirEpisodio(ep, canal)}${describirFeedback(feedback)}

TAREA: Primero extrae el gancho. Luego crea 3 propuestas de portada + título, una por composición
(Triangulo, Amenaza, Victima sola). Si alguna composición no encaja con la historia, usa "Otra" con la idea más fuerte.
Cada título usa una fórmula distinta cuando sea posible. Califica con honestidad: no todas valen 90.
En prompt_imagen describe: escena, posición de cada personaje (por nombre), emoción exacta de cada cara, vestuario, objeto clave,
color saturado, luz, "no text, no letters, no watermark", espacio libre abajo a la izquierda para el logo. Formato 16:9.
ENCUADRE OBLIGATORIO: plano medio cerrado, las caras principales ocupan al menos un tercio del alto de la imagen,
máximo 3 personas protagonistas, extras desenfocados al fondo, nada importante en la esquina inferior derecha.
Escribe porque_funciona y riesgo cortos y directos: el equipo los lee rápido.`;
  return llamar({ content, schema: RespuestaPropuestas, effort: "high" });
}

export async function rehacerPropuesta(ep, canal, anterior, { objetivo, razones, comentario }, feedback) {
  const queCambiar = {
    portada: "Rehaz SOLO la portada (concepto y prompt_imagen). Conserva el título exactamente igual.",
    titulo: "Rehaz SOLO el título. Conserva concepto, composición y prompt_imagen exactamente iguales.",
    ambos: "Rehaz título y portada.",
  }[objetivo];
  const content = `${describirEpisodio(ep, canal)}${describirFeedback(feedback)}

PROPUESTA QUE NO GUSTÓ:
${JSON.stringify({ titulo: anterior.titulo, concepto: anterior.concepto, composicion: anterior.composicion, prompt_imagen: anterior.prompt_imagen })}

POR QUÉ NO GUSTÓ: ${[...razones, comentario].filter(Boolean).join("; ") || "sin razón indicada"}

TAREA: ${queCambiar} Corrige exactamente lo que el equipo señaló. Mantén el encuadre cerrado (caras grandes).
Devuelve el gancho y UNA sola propuesta en "propuestas".`;
  const r = await llamar({ content, schema: RespuestaPropuestas, effort: "high" });
  return r.propuestas[0];
}

export async function evaluarPortada({ imagen, propuesta, referencias }) {
  const content = [
    ...referencias.flatMap((r) => [
      { type: "text", text: `Foto de referencia de ${r.personaje}:` },
      { type: "image", source: { type: "base64", media_type: r.mime, data: r.base64 } },
    ]),
    { type: "text", text: "PORTADA GENERADA:" },
    { type: "image", source: { type: "base64", media_type: imagen.mime, data: imagen.base64 } },
    {
      type: "text",
      text: `Título que la acompaña: "${propuesta.titulo}"
Concepto pedido: ${propuesta.concepto}

Evalúa la portada contra el playbook como la vería alguien en su celular a 168x94 px:
¿se entiende la historia?, ¿hay acción y reacción?, ¿las emociones se leen?, ¿hay objeto clave?, ¿hay color que salte?
Revisa defectos: manos o caras deformes, texto o letras dentro de la imagen, caras que no se parecen a las referencias,
cualquier cosa que viole las reglas de seguridad de marca. "aprobada" = false si hay un defecto grave.
porque_funciona: 3 razones de máximo 12 palabras. problemas: máximo 2, de máximo 12 palabras cada uno, solo los que más importan (vacía si no hay).`,
    },
  ];
  return llamar({ content, schema: Evaluacion, effort: "medium", maxTokens: 8000 });
}

export async function generarPaquete(ep, canal, propuesta) {
  const content = `${describirEpisodio(ep, canal)}

TÍTULO ELEGIDO: "${propuesta.titulo}"
PORTADA: ${propuesta.concepto}

TAREA: Escribe el paquete de publicación.
- descripcion_gancho: 2 líneas que enganchen sin revelar el final.
- tags: 12-15 tags (canal, tema, emociones, formatos como "historias de vida", "capítulos completos", "telenovelas", programas del mismo género como "la rosa de guadalupe"). Que no pasen de 450 caracteres en total.
- hashtags: 3-5 con #.
- titulos_alternos: 2 variantes del título para prueba A/B.`;
  const r = await llamar({ content, schema: Paquete, effort: "low", maxTokens: 8000 });
  const hashtags = [...new Set([...(canal.hashtags_base || []), ...r.hashtags])].slice(0, 6);
  return {
    ...r,
    hashtags,
    descripcion: [r.descripcion_gancho, canal.descripcion_fija, canal.disclaimer, hashtags.join(" ")].filter(Boolean).join("\n\n"),
  };
}
