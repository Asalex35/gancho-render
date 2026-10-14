import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { PLAYBOOK } from "./playbook.js";
import { config } from "../config.js";
import { als, semaforo } from "../contexto.js";

// Pocos reintentos aquí: la cola ya reintenta con espera. Tiempo máximo por llamada: 5 min.
const client = new Anthropic({ apiKey: config.anthropicKey, maxRetries: 1, timeout: 240e3 });
// Límite real de llamadas simultáneas a Claude en este proceso (todas las colas juntas).
// Dos filas: una revisión rápida (Haiku) no espera detrás de propuestas largas (Sonnet).
const turnoCreativo = semaforo(Number(process.env.CLAUDE_CONCURRENCY || 4));
const turnoRapido = semaforo(Number(process.env.CLAUDE_CONCURRENCY || 4));

// ---------- Esquemas ----------
const Calificacion = z.object({
  total: z.number().int().describe("0-100, probabilidad estimada de que funcione"),
  tabu: z.number().int().describe("1-10"),
  especificidad: z.number().int().describe("1-10"),
  misterio: z.number().int().describe("1-10"),
  claridad_visual: z.number().int().describe("1-10"),
});
const Propuesta = z.object({
  titulo: z.string().describe("En el idioma del canal"),
  traduccion: z.string().describe("Traducción del título al español si el canal NO es en español; si es en español, cadena vacía"),
  formula: z.enum(["A", "B", "C", "D", "Libre"]),
  composicion: z.enum(["Triangulo", "Amenaza", "Victima sola", "Otra"]),
  concepto: z.string().describe("Qué se ve en la portada, en español, 1-2 frases"),
  personajes_en_portada: z.array(z.string()).describe("Nombres de personaje EXACTOS del cast que aparecen en la imagen"),
  prompt_imagen: z.string().describe("Prompt en inglés para Nano Banana, detallado, refiriéndose a los personajes por su nombre"),
  calificacion: Calificacion,
  porque_funciona: z.array(z.string()).describe("3 razones, máximo 12 palabras cada una"),
  riesgo: z.string().describe("El punto débil principal, máximo 15 palabras"),
});
const DisenoFormato = z.object({
  personajes_en_portada: z.array(z.string()).describe("Nombres EXACTOS del cast que salen en la imagen"),
  texto_principal: z.string().describe("Texto que va DENTRO de la imagen (título de serie/película o frase). Cadena vacía si el formato no lleva texto"),
  texto_secundario: z.string().describe("Tagline corta (máx. 8 palabras) o cadena vacía"),
  prompt_imagen: z.string().describe("Prompt en inglés para el generador de imágenes, detallado, refiriéndose a los personajes por su nombre"),
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
const AnalisisVideo = z.object({
  titulo_interno: z.string().describe("Nombre corto del episodio en español"),
  sinopsis: z.string().describe("En español, 6-10 líneas"),
  giro: z.string(), momento: z.string(), desenlace: z.string(), escenario: z.string(),
  personajes: z.array(z.object({
    personaje: z.string().describe("Nombre del personaje en la historia"),
    edad: z.string(),
    rol: z.enum(["transgresor", "victima", "testigo", "villano", "otro"]),
    vestuario: z.string(),
    descripcion_visual: z.string().describe("Cómo se ve: cabello, complexión, ropa (sin nombres de personas reales)"),
    hablante: z.string().describe("Letra del hablante en la transcripción (A, B…) o cadena vacía si no se sabe"),
    persona: z.number().int().describe("Número P de la fila de caras que es este personaje; 0 si ninguna"),
    cuadros: z.array(z.number().int()).describe("Solo si no hay filas P para este personaje: números de cuadro general donde se le ve la cara (máx. 3)"),
  })),
  cuadros_momento: z.array(z.number().int()).describe("Cuadros que muestran el lugar y ambiente del momento cumbre (máx. 2)"),
  calidad: z.enum(["completa", "parcial"]).describe("parcial si faltó información (sin diálogo, video incompleto)"),
});
const SugerenciaCanal = z.object({
  voz: z.string().describe("Cómo se escriben los títulos de este canal, 1-3 frases en español"),
  estilo_visual: z.string().describe("Rasgos visuales de sus portadas, 1-3 frases en español"),
  hashtags: z.array(z.string()).describe("3-4 hashtags fijos en el idioma del canal"),
  tags_base: z.array(z.string()).describe("6-8 tags base en el idioma del canal"),
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

async function llamar({ content, schema, effort = "medium", maxTokens = 16000, creativo = false }) {
  const fmt = zodOutputFormat(schema);
  let res;
  try {
    res = await (creativo ? turnoCreativo : turnoRapido)(() => client.beta.messages.create({
      model: creativo ? config.claudeModelCreativo : config.claudeModel,
      max_tokens: maxTokens,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      output_config: { effort, format: { type: fmt.type, schema: fmt.schema } },
      messages: [{ role: "user", content }],
    }, { signal: als.getStore()?.signal }));
  } catch (e) {
    if (e instanceof Anthropic.APIUserAbortError) throw e;
    if (e instanceof Anthropic.RateLimitError || e instanceof Anthropic.InternalServerError || e instanceof Anthropic.APIConnectionError) {
      throw new ErrorIA("Claude está saturado; se reintentará.", { reintentable: true });
    }
    if (e instanceof Anthropic.AuthenticationError) throw new ErrorIA("La API key de Claude no es válida.");
    throw e;
  }
  if (res.stop_reason === "refusal") throw new ErrorIA("La IA no quiso escribir esto: la historia tiene algo que considera sensible (menores en una situación romántica o sexual, violencia muy explícita o una persona real). Suaviza la sinopsis o las notas y vuelve a intentar.");
  if (res.stop_reason === "max_tokens") throw new ErrorIA("La respuesta de Claude salió demasiado larga. Acorta la sinopsis o el guion.");
  const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return fmt.parse(text);
}

const IDIOMAS = { es: "español", en: "inglés", pt: "portugués de Brasil" };
export const nombreIdioma = (c) => IDIOMAS[c] || c;

function describirCanal(canal) {
  const ej = (canal.ejemplos || []).slice(0, 12);
  return `CANAL: ${canal.nombre}
IDIOMA DEL CANAL: ${nombreIdioma(canal.idioma)}${canal.pais ? ` · público de ${canal.pais}` : ""}
VOZ DE LOS TÍTULOS: ${canal.voz || "sigue el playbook"}
ESTILO VISUAL DE SUS PORTADAS: ${canal.estilo_visual || "sigue el playbook"}${ej.length ? `\nTÍTULOS QUE YA FUNCIONARON EN ESTE CANAL:\n${ej.map((t) => `- ${t}`).join("\n")}` : ""}`;
}

function describirEpisodio(ep, canal) {
  const b = ep.brief;
  const cast = (ep.cast || []).map((c) =>
    `- ${c.personaje} (${c.edad || "edad no indicada"}), rol: ${c.rol}, vestuario: ${c.vestuario || "libre"}, actor: ${c.actorNombre || "sin asignar"}${c.tieneFotos ? " · CON FOTO (debe salir)" : ""}`).join("\n");
  return `${describirCanal(canal)}

SINOPSIS: ${b.sinopsis}${b.duracion_min ? `\nDURACIÓN DEL EPISODIO: ${b.duracion_min} min` : ""}
GIRO PRINCIPAL: ${b.giro || "(dedúcelo)"}
MOMENTO CUMBRE: ${b.momento || "(dedúcelo)"}
DESENLACE (no revelar nunca): ${b.desenlace || "(desconocido)"}
ESCENARIO: ${b.escenario || "libre"}
NOTAS DEL EQUIPO: ${b.notas || "ninguna"}${b.hack ? "\nESTE VIDEO ES UN HACK (recopilación de varios episodios): portada, título, descripción y tags SOLO de la PRIMERA historia; no menciones las demás." : ""}

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
máximo 4 personas protagonistas, extras desenfocados al fondo, nada importante en la esquina inferior derecha.
ACTORES CON FOTO: todos los personajes marcados "CON FOTO" salen en CADA una de las 3 portadas (si son más de 4, los 4 más importantes),
con la cara visible, y van en personajes_en_portada con su nombre EXACTO del cast. En "Víctima sola" la víctima va al frente y los demás más chicos atrás.
Escribe porque_funciona y riesgo cortos y directos: el equipo los lee rápido.
PERSONAJES SIN ACTOR (sin foto): en prompt_imagen dales rasgos claramente distintos a los de los actores con foto (otro color y peinado de cabello, otra edad o complexión), para que la imagen no repita la cara del protagonista.
ANTES DE RESPONDER revisa cada título: si insinúa o menciona algo del DESENLACE (cómo termina, quién regresa, embarazos, castigos, éxitos futuros), reescríbelo.
IDIOMA: títulos en ${nombreIdioma(canal.idioma)}${canal.idioma !== "es" ? " (y su traducción al español en traduccion)" : ""}; todo lo demás para el equipo en español.`;
  const r = await llamar({ content, schema: RespuestaPropuestas, effort: "high", creativo: true });
  for (const pr of r.propuestas || []) asegurarActores(pr, ep.cast);
  return r;
}

// Nombres del cast tal cual; si Claude escribe "La novia" en vez de "Novia", se corrige al nombre exacto.
const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/^(el|la|los|las)\s+/, "").trim();
export const mismoPersonaje = (a, b) => { const x = norm(a), y = norm(b); return Boolean(x && y) && (x === y || x.includes(y) || y.includes(x)); };
export function asegurarActores(propuesta, cast) {
  const conFoto = (cast || []).filter((c) => c.tieneFotos).slice(0, 4);
  const nombres = (propuesta.personajes_en_portada || []).map((n) => (cast || []).find((c) => mismoPersonaje(c.personaje, n))?.personaje || n);
  const faltan = conFoto.filter((c) => !nombres.some((n) => mismoPersonaje(n, c.personaje)));
  propuesta.personajes_en_portada = [...new Set([...nombres, ...faltan.map((c) => c.personaje)])];
  if (faltan.length) propuesta.prompt_imagen += `\nALSO INCLUDE in the scene, face clearly visible (secondary position, smaller or behind): ${faltan.map((c) => c.personaje).join(", ")}.`;
  return propuesta;
}

// Versión de una portada para otra plataforma (TikTok, Instagram, Facebook, Prisma Plus).
const TEXTOS = {
  ninguno: "Este formato NO lleva texto: texto_principal y texto_secundario vacíos.",
  titulo_grande: "texto_principal: título de serie corto y dramático (2 a 5 palabras), estilo apps de series, propio de ESTA historia (inventa uno; no uses frases de ejemplo). texto_secundario: tagline opcional muy corta.",
  frase_corta: "texto_principal: frase gancho de máximo 6 palabras que provoque (no cuenta el final). texto_secundario vacío.",
  titulo_pelicula: "texto_principal: título de PELÍCULA evocador (1 a 4 palabras), distinto al título de YouTube, con peso de cine, propio de ESTA historia (inventa uno; no uses frases de ejemplo). texto_secundario: tagline de póster (máx. 8 palabras).",
};
export async function disenarFormato({ ep, canal, propuesta, formato }) {
  const content = `${describirEpisodio(ep, canal)}

${propuesta ? `PORTADA DE YOUTUBE ELEGIDA (misma historia y mismos actores, pero NO copies su composición):
Título: "${propuesta.titulo}"
Concepto: ${propuesta.concepto || ""}` : "No hay portada de YouTube: diseña directo desde la historia, eligiendo el momento más fuerte para esta plataforma."}

NUEVO FORMATO: ${formato.nombre} · proporción ${formato.aspecto}
GUÍA VISUAL (en inglés, síguela al pie de la letra): ${formato.guia}

TEXTO EN LA IMAGEN: ${TEXTOS[formato.texto]}
Todo texto en ${nombreIdioma(canal.idioma)}, con ortografía perfecta y acentos. Nunca reveles el desenlace.
ACTORES CON FOTO: los personajes marcados "CON FOTO" salen en la imagen (máx. 4) y van en personajes_en_portada con su nombre exacto.
En prompt_imagen: describe composición vertical u horizontal según la proporción, posición y emoción de cada personaje (por nombre),
vestuario, luz y color, y si lleva texto escribe literalmente: the title text reads "<texto_principal>" (y la tagline si aplica), indicando tipografía y posición.
Termina con: "photorealistic, no watermark, no extra text, no logos".`;
  const r = await llamar({ content, schema: DisenoFormato, effort: "medium", maxTokens: 6000, creativo: true });
  return asegurarActores(r, ep.cast);
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
  const r = await llamar({ content, schema: RespuestaPropuestas, effort: "high", creativo: true });
  return asegurarActores(r.propuestas[0], ep.cast);
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
  return llamar({ content, schema: Evaluacion, effort: "low", maxTokens: 8000 });
}

export async function generarPaquete(ep, canal, propuesta) {
  const content = `${describirEpisodio(ep, canal)}

TÍTULO ELEGIDO: "${propuesta.titulo}"
PORTADA: ${propuesta.concepto}

TAREA: Escribe el paquete de publicación TODO en ${nombreIdioma(canal.idioma)}, como nativo${canal.pais ? ` de ${canal.pais}` : ""}.
- descripcion_gancho: 2 líneas que enganchen sin revelar el final.
- tags: 12-15 tags (canal, tema, emociones, formatos como "historias de vida", "capítulos completos", "telenovelas", programas del mismo género que busque ese público). Incluye estos tags base si existen: ${(canal.tags_base || []).join(", ") || "ninguno"}. Que no pasen de 450 caracteres en total.
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


// ---------- Flujo automático: entender el episodio desde el video ----------
export async function analizarVideo({ canal, transcripcion, hojas, hojasCaras = [], personas = [], conHablantes, parcial, duracionMin, nombreArchivo, notas }) {
  const content = [
    ...hojas.flatMap((hj) => [
      { type: "text", text: `Hoja de cuadros generales ${hj.desde}-${hj.hasta} (número arriba a la izquierda):` },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: hj.base64 } },
    ]),
    ...hojasCaras.flatMap((hj) => [
      { type: "text", text: "Personas del episodio: cada fila (P1, P2…) son caras de UNA misma persona, agrupadas por un comparador de rostros." },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: hj.base64 } },
    ]),
    {
      type: "text",
      text: `${describirCanal(canal)}

ARCHIVO: ${nombreArchivo || "sin nombre"}
DURACIÓN: ${duracionMin ? `${duracionMin} min` : "desconocida"}
NOTAS DEL EQUIPO: ${notas || "ninguna"}

TRANSCRIPCIÓN DEL EPISODIO${transcripcion ? (parcial ? " (parcial: inicio, mitad y final del episodio)" : "") : " (no disponible: deduce la historia solo con los cuadros)"}${conHablantes ? " — cada línea dice [hablante minuto]" : ""}:
${transcripcion ? transcripcion.slice(0, 180000) : "-"}

TAREA: Eres el editor que vio el episodio completo. Escribe el brief para hacer la portada:
sinopsis, giro principal, momento más fuerte para la portada, desenlace y escenario (todo en español).
Lista los personajes importantes (máx. 4).${conHablantes ? `
Usa la transcripción para saber qué letra de hablante es cada personaje (por cómo los llaman y lo que dicen).` : ""}
${personas.length ? `DATOS DE LAS PERSONAS DETECTADAS:
${personas.map((p) => `- P${p.n}: aparece en ${p.apariciones} cuadros${p.hablante ? `, casi siempre mientras habla ${p.hablante}` : ""}${p.actor ? `, el comparador la reconoce como el actor/actriz de la biblioteca "${p.actor}"` : ""}`).join("\n")}
Asigna a cada personaje su fila P usando la historia, quién habla, el vestuario, la edad y el papel. Una fila P es de un solo personaje.` : ""}
Identifícalos por su papel en la historia, NUNCA por quiénes son en la vida real.
Si no estás seguro de qué fila es de quién, pon 0. Si no hay filas útiles, usa "cuadros" de las hojas generales.
En cuadros_momento elige los cuadros generales que mejor muestran el lugar del momento cumbre.`,
    },
  ];
  return llamar({ content, schema: AnalisisVideo, effort: "high", maxTokens: 12000, creativo: true });
}

// ---------- Ayuda para crear canales ----------
export async function sugerirCanal({ nombre, idioma, pais, ejemplos }) {
  const content = `CANAL NUEVO: ${nombre}
IDIOMA: ${nombreIdioma(idioma)}${pais ? ` · público de ${pais}` : ""}
TÍTULOS QUE MEJOR LE HAN FUNCIONADO:
${ejemplos.map((t) => `- ${t}`).join("\n")}

TAREA: Describe la voz de sus títulos (qué fórmula del playbook usan, persona, largo, palabras gancho) y el estilo visual
que deberían tener sus portadas según el playbook. Propón hashtags fijos y tags base en el idioma del canal.`;
  return llamar({ content, schema: SugerenciaCanal, effort: "low", maxTokens: 4000 });
}
