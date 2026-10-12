// Playbook fijo, basado en el análisis de los videos más vistos de
// "Cuando Los Ángeles Caen" (CLAC) y Andy Torres (1 oct 2026).
// Estrategia puede editar este texto sin tocar el resto del código.

// Canales iniciales. Después se editan desde Administración (tabla "canales").
export const CANALES_SEMILLA = {
  CLAC: {
    nombre: "Cuando Los Ángeles Caen",
    idioma: "es",
    pais: "México",
    voz: "Tercera persona. Arquetipo social (millonario, mesera, payaso, suegra, novia) + una acción tabú + cierre abierto ('sin imaginar', 'y así reaccionó', 'su vida cambió para siempre'). Sin edades ni nombres.",
    descripcionFija:
      "No todos los ángeles tienen alas. A veces, son personas comunes en momentos extraordinarios. Cuando los ángeles caen te presenta las historias de quienes vieron su vida transformada por un acto de bondad casi milagroso.\nUna serie que te tocará el alma. Mírala por Multimedios, Canal 6.",
    disclaimer:
      "Esta historia y sus personajes son ficticios, todos son actores y nadie fue afectado en la realización de este video.",
    hashtagsBase: ["#cuandolosangelescaen", "#CuandoLosAngelesCaenOficial"],
  },
  ANDY_TORRES: {
    nombre: "Andy Torres",
    idioma: "es",
    pais: "México",
    voz: "Primera persona, confesión ('Mi hermana...', 'Me casé...'). Traición doble en el momento de máximo daño.",
    descripcionFija:
      "💔 Historias que te conmueven, inspiran y te harán reflexionar.\n📌 Suscríbete para no perderte ningún episodio: https://www.youtube.com/@andytorresoficial\n👍 Dale like, comenta tu opinión y comparte con alguien que necesita escuchar esta historia.",
    disclaimer:
      "DISCLAIMER: Este video es contenido dramatizado y de ficción. Todos los personajes son interpretados por actores profesionales y las historias son desarrolladas por el equipo de Prismáticoos con fines narrativos y de entretenimiento.",
    hashtagsBase: ["#AndyTorres", "#Prismaticoos"],
  },
};

export const PLAYBOOK = `
# PLAYBOOK DE PORTADAS Y TÍTULOS (dramas latinos en YouTube)

## Datos de referencia
- CLAC (2.6M subs): sus 16 videos top tienen 9M–18M vistas. Ejemplos:
  "Maestra se enamoró de su guapo alumno sin imaginar cómo terminaría" (18M)
  "Le invadieron su casa a una abuelita sin imaginar lo que haría" (17M)
  "Elena de 45 años enamora a los amigos de su hijo sin imaginar lo que pasaría" (16M)
  "Sofía lo dejó por pobre sin saber que se haría millonario" (12M)
  "Pagó la boda de su hijastra y no lo invitaron, pero él hizo ESTO en venganza" (9.5M)
  "Taxista descubre a su esposa con el guapo jefe y así reaccionó" (9M)
- Andy Torres (411K subs): el #1 hizo 5.7M y el #2 solo 1.2M.
  #1: "Mi hermana se fugó con mi prometido el mismo día de mi boda" (traición doble + peor momento posible).
  Los que rinden menos describen sentimientos ("Me enamoré de mi patrón") en vez de una traición concreta con víctima.

## Fórmulas de título
A) "Sin imaginar": [personaje con etiqueta] + [acción transgresora] + "sin imaginar / sin saber" + [consecuencia abierta]. 10 de 16 top de CLAC.
B) Karma de clase: [nombre] + "lo/la dejó por pobre" + "sin saber que" + "se haría millonario / ganaría la lotería". 6 de 16.
C) Reacción o venganza: [personaje] + [descubre / sufre una ofensa] + "y así reaccionó" / "hizo ESTO".
D) Confesión en primera persona: "Mi" + [familiar] + [traición doble] + [momento exacto de máximo daño].

## Reglas duras de título (2026, mandan sobre los ejemplos de arriba)
- El título NO describe la portada ni cuenta la historia: plantea UNA tensión y se calla lo importante. La portada muestra; el título provoca.
  Mal: "Yosuani, con vestido de novia, supo la traición en su boda y así reaccionó" (narra lo que ya se ve).
  Bien: "Novia descubre la traición en pleno altar y hace algo que nadie esperaba".
- Sin edades ("de 58 años") y sin nombres propios de personajes ni de actores. Usa arquetipos: madre, suegra, novia, millonario, enfermero, mesera.
- Un solo giro por título, 45–70 caracteres. Verbos de acción en presente o pasado simple.
- Títulos actuales de CLAC que funcionan: "Payaso descubre a su esposa con otro y decide darle una lección",
  "Millonario salvó a una mesera inmigrante y su vida cambió para siempre", "Millonario convierte a una vagabunda en super modelo".

Ingredientes: arquetipo social (suena a caso real); un tabú cotidiano (edad, infidelidad, traición familiar, dinero vs amor);
el final siempre oculto; escenario de alto riesgo (boda, funeral, hospital); 45–70 caracteres; sin emojis; mayúsculas en máximo una palabra.

## Portada
- SIN TEXTO. El título explica la portada y la portada congela el momento del título. Nunca repiten la misma información.
- Composición 1 "Triángulo" (10 de 16 en CLAC): pareja transgresora en acción (beso/abrazo) en primer plano + testigo que los descubre
  con emoción extrema (llanto, manos en la cabeza, ira, un arma o un bate).
- Composición 2 "Amenaza inminente": peligro que se entiende sin leer (abuelita con pistola, perro junto a un bebé, padre armado).
- Composición 3 "Víctima sola en su peor momento": novia llorando en el piso de una iglesia vacía, novia empapada en la carretera.
- Vestuario que identifica el rol (uniforme escolar, de sirvienta, vestido de novia, bata).
- Un objeto que resume el giro (boleto de lotería, letrero de "$20", auto con moño, cinta "CANCELADO", papel de divorcio).
- Un color saturado (vestido rojo, rosa o azul) contra fondo neutro. Escenarios latinoamericanos cotidianos (camión, calle, escuela, tiendita, iglesia).
- Hiperrealista, cinematográfico, nítido, caras grandes. Esquina inferior izquierda libre para el logo, esquina inferior derecha libre (duración).
- Debe entenderse a 168x94 px (miniatura en celular).

## Canales en otros idiomas
El playbook está en español, pero aplica igual en cualquier idioma. Escribe títulos, descripciones, tags y hashtags
como un nativo del país del canal: adapta las fórmulas, NUNCA traduzcas palabra por palabra.
- Inglés (EE. UU.): "...without knowing...", "...never imagining what would happen", "...and this is how he reacted",
  "...but she did THIS". Sentence case o Title Case según el canal. Edad con coma: "Elena, 45, ...".
- Portugués (Brasil): "...sem imaginar o que aconteceria", "...sem saber que...", "...e olha como ele reagiu",
  "...mas ela fez ISSO". Usa nombres y escenarios creíbles para Brasil si la historia lo permite.
- Los escenarios de la portada deben verse del país del canal (México, EE. UU., Brasil...).
Las explicaciones para el equipo (concepto, por qué funciona, riesgo, gancho) van SIEMPRE en español.

## Luz (obligatoria)
- Portadas claras, con luz brillante y colores vivos, aunque la escena sea de noche o en un hospital: la competencia (CLAC, Andy Torres) usa fondos claros y saturados, y una portada oscura se pierde junto a ellas. Nada de escenas en penumbra.

## Reglas de seguridad de marca (obligatorias)
- Nunca sexualizar ni poner en escenas románticas a menores de edad. Si un personaje es menor, mostrarlo solo en contexto familiar no romántico.
- Un personaje adulto con pareja, novio o prometido NUNCA lleva nada que parezca uniforme escolar (corbata, chaleco, falda de cuadros), aunque la foto de referencia lo sugiera: en prompt_imagen escribe su edad adulta y ropa casual de adulto.
- Sin desnudos, sin sangre, sin heridas visibles, sin violencia gráfica (riesgo de restricción de edad y desmonetización).
- Las armas pueden aparecer como amenaza, nunca disparando ni con víctimas heridas.
- No usar nombres de personas reales en títulos.
`;
