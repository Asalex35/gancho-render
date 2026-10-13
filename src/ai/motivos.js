// Traduce los errores técnicos de los proveedores (Nano Banana, Google, Seedream, Claude) a un motivo claro
// para el equipo, con lo que conviene hacer. El texto original se guarda aparte para el administrador.
const REGLAS = [
  [/credit|crédit|\b402\b|insufficient|balance/i,
    "Se acabaron los créditos de Nano Banana. Pide una recarga al administrador."],
  [/safety|unsafe|sensitive|prohibit|policy|nsfw|flagged|blocked|harm|violat|moderat|filtered|inappropriate|not allowed|refus|no quiso/i,
    "La IA no quiso hacer esta imagen: consideró la escena sensible (violencia, sangre, desnudos, menores o una persona famosa). Usa «Ajustar» o «Rehacer» con una escena más suave."],
  [/tard[oó]|timeout|timed out|demasiado/i,
    "Nano Banana tardó demasiado. Dale «Otra vez»; si sigue, intenta más tarde."],
  [/key|\b401\b|\b403\b|auth/i,
    "La llave del servicio de imágenes no es válida. Avísale al administrador."],
  [/conexi[oó]n|ECONN|network|fetch failed|saturad|\b429\b|\b5\d\d\b|overload|unavailable/i,
    "El servicio de imágenes está saturado o sin conexión. Dale «Otra vez» en unos minutos."],
  [/descarg|download|referencia|reference|url/i,
    "No se pudo descargar una foto de referencia o la imagen final. Dale «Otra vez»."],
  [/almacenamiento|storage|guardar/i,
    "La imagen se hizo pero no se pudo guardar. Avísale al administrador."],
];

export function motivoAmigable(texto, porDefecto = "No se pudo hacer la imagen. Dale «Otra vez»; si sigue, avisa al administrador.") {
  const t = String(texto || "");
  for (const [re, motivo] of REGLAS) if (re.test(t)) return motivo;
  return porDefecto;
}
