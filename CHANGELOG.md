# Cambios de Gancho

## 0.4.2 — 2026-10-12
- **Sin personajes duplicados**: cada cara de referencia es de un solo personaje; los personajes sin foto llevan rasgos claramente distintos.
- La revisión automática cuenta cuántas veces aparece la cara del actor: si sale repetida, marca el problema y la repinta sola.

## 0.4.1 — 2026-10-12
- **Títulos y propuestas con Claude Sonnet** (Haiku sigue para descripción, tags y revisión): con Haiku los títulos salían narrativos.
- **Reglas duras de título**: no describir la portada ni contar la historia, sin edades ni nombres propios (solo arquetipos), 45–70 caracteres, un solo giro.
- La voz de CLAC se actualizó a arquetipos (solo si no se había editado a mano).

## 0.4.0 — 2026-10-12
- **Hacks** (varios episodios en un video): al subirlo se marca "Es un hack". Gancho encuentra dónde termina el 1er episodio (pantalla negra + silencio, o el minuto que escriba el equipo) y saca transcripción, cuadros, caras y subtítulos solo de ese episodio. Portada y título son solo de la primera historia.
- **Transcripción**: máximo 25 min por episodio (antes 40): inicio, medio y final.
- **Imágenes en 1K** (1376×768): YouTube muestra 1280×720, sale más rápido y cuesta igual. Revisión de la imagen cada 5 s y aviso inmediato de Nano Banana.
- **Historial por perfil**: cada quien ve solo lo que generó (episodios, lotes, videos); nadie abre lo de otro por enlace (el admin sí, para soporte).
- **Descargar portada** en cada propuesta (JPG 1280×720 con logo del canal).
- **Vista en YouTube** abre directo en Tendencias MX, con opción de Búsqueda; se quitó "Mi competencia".

## 0.3.0 — 2026-10-12
- **Claude Haiku** como modelo por defecto (el más barato) para todo: propuestas, títulos, descripción, tags y revisión de portadas.
- `CLAUDE_MODEL_CREATIVO` permite subir solo propuestas/títulos y lectura del video a un modelo mejor (p. ej. `claude-sonnet-5-5`) si baja la calidad, sin encarecer lo demás.

## 0.2.0 — 2026-10-12
- **Vista previa "Así se ve en YouTube"**: cada portada se ve en computadora (inicio y sugeridos), celular (inicio y búsqueda) y televisión, rodeada de portadas reales de otros canales.
- **Competencia**: se pegan links de canales o videos (sin llave). Con `YOUTUBE_API_KEY` también se ve junto a tendencias de México y búsquedas reales, con vistas y duración.
- **Portadas más claras**: el prompt pide luz brillante y colores vivos; si una portada sale oscura (menos de 105 de luz, la competencia promedia ~116) se aclara sola.
- **Más parecido**: con pocas fotos del actor se manda también la foto original (peinado y vestuario), no solo la cara recortada.
- **Créditos**: si un repintado automático falla (p. ej. sin créditos), se conserva la portada anterior; no se repinta si no se sabe el saldo; "sin créditos" ya no se reintenta solo.
- **Seguridad de marca**: un adulto con pareja nunca lleva algo que parezca uniforme escolar.

## 0.1.0
- Portadas, títulos, descripción y tags con 3 propuestas calificadas; flujos manual, masivo y automático desde el video; canales en es/en/pt; biblioteca de caras por actor; proveedores de imagen de respaldo.
