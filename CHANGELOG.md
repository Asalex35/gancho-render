# Cambios de Gancho

## 0.5.3 — 2026-10-13
- **Solo redes o Prisma Plus**: se puede pedir solo TikTok, solo Facebook, solo el póster, etc., directo desde la historia del episodio, sin hacer antes la portada de YouTube. Botón "✦ Solo redes o Prisma Plus" al empezar y "✦ Redes y Prisma Plus" siempre arriba del episodio.
- En Inicio, si un episodio solo tiene versiones de redes, se muestra la última como miniatura.

## 0.5.2 — 2026-10-13
- Versiones (redes y Prisma Plus): si el servidor se reinicia o Nano Banana tarda, la imagen ya pagada se retoma y se recupera (hasta 40 min) en vez de perderse.
- Textos: "imágenes" con acento, "Pintando… tarda 1 a 3 min", "El gancho de la historia".
- CSP sin reglas duplicadas.

## 0.5.1 — 2026-10-13 · Más fácil de usar
- Ya no aparece "null" en pantallas y ventanas con partes vacías.
- Administrador: interruptor "Solo lo mío / Todo el equipo" en Inicio, Automático y Prisma Plus.
- Inicio: botón principal "⬆ Subir video". Menú en una sola línea.
- "3 propuestas nuevas" pide confirmación (muestra el costo) y no se puede usar mientras se pintan las actuales.
- Lo que escribes en la descripción/tags ya no se borra con el refresco automático; si falla la descripción, se ve el aviso.
- Regenerar textos editados a mano pide confirmación. En videos automáticos el botón dice "Aprobar esta". "Versiones" del historial ahora se llama "Anteriores".
- Lote: no deja lanzar si no alcanzan los créditos.
- Redes y Prisma Plus: el botón dice cuántas imágenes y créditos ("Crear 2 imágenes · 36 créditos"), no se puede mandar vacío ni dos veces, botón "Otra vez" si una falla, tiempo estimado.
- Hacks: se ve dónde se cortó el 1er episodio (y si fue calculado); el minuto acepta "38", "38:20" o "1:05:30".
- Subidas: aviso al cerrar la pestaña durante una subida y si ya hay otra en curso.
- Descargas con nombre completo ("… - opcion 2", "… - TikTok") y aviso si fallan; "Sin conexión" en vez de errores técnicos.
- Al hacer clic en el nombre de un campo ya no cambia la opción elegida. La duración del episodio es opcional.

## 0.5.0 — 2026-10-13
### Nuevo: versiones para redes y Prisma Plus
- Botón **"✦ Redes y Prisma Plus"** en cada portada lista: TikTok/Reels 9:16 (estilo apps de series como DramaShorts/ReelShort, con título grande), Instagram 4:5, Facebook 1:1, y para **Prisma Plus** póster de película 2:3 y banner de la app 16:9 (fotorrealista, nivel cine, en 2K).
- Claude diseña cada versión (composición y texto dentro de la imagen) con los mismos actores y sus fotos; se descargan a la medida exacta de cada plataforma.
- Nueva sección **Prisma Plus** en el menú con todos los pósters y banners.
### Seguridad (auditoría completa)
- Las rutas distinguen mayúsculas: `/api/Episodios/...` ya no se salta la revisión de dueño.
- Subida de videos: solo la llave que emitió el servidor para ese usuario (firma), solo extensiones de video, una a la vez por usuario y revisión de espacio libre; el temporal se escribe en el mismo disco.
- ffmpeg fuerza el formato por extensión y solo permite los protocolos necesarios (un "video" falso ya no puede leer direcciones internas).
- Login: límite por cuenta además de por IP; la contraseña se revisa sin congelar el servidor; la cookie ya no lleva parte del hash.
- Llave propia para los enlaces públicos de fotos; aviso de Nano Banana con comparación segura y límite; avisos solo a Slack/Google Chat/Discord y sin @everyone; descargas sin redirecciones; CSP más estricta; tiempo máximo por petición.
- Render: la base de datos ya no acepta conexiones desde internet (`ipAllowList: []`); `LINK_SECRET` propio.
### Velocidad y costo
- La revisión de la portada (Claude) y el detector de caras corren en paralelo; Claude revisa con poco esfuerzo y una imagen más chica.
- Si el detector no encuentra caras ya no se castiga el parecido (evita repintados pagados por error).
- Colas de imagen revisan cada medio segundo; el aviso de Nano Banana ya no duplica la revisión.
- Portadas guardadas a máx. 1920 px (más ligeras); compresión de la página (~4 veces menos datos); el episodio ya no manda la transcripción en cada refresco.
- Claude con dos filas (rápida y creativa) para que la revisión no espere detrás de las propuestas.

## 0.4.6 — 2026-10-12
- Fotos de actores con la cara chica (cuerpo completo, grupo): si no aparece una cara, Gancho la busca con zoom en partes de la foto.

## 0.4.5 — 2026-10-12
- **Arreglo de parecido**: el detector descartaba la cara de fotos de actores retocadas o en 3/4 (filtro de nitidez pensado para video). Las fotos oficiales ahora usan filtros suaves; sin esto el actor se quedaba sin cara de referencia y sin medición de parecido.
- La medición de parecido en la portada también acepta la piel lisa de las imágenes de IA.
- Si una foto de actor no tiene una cara usable, queda en el registro con un aviso claro (antes se reintentaba en silencio en cada arranque).

## 0.4.4 — 2026-10-12
- Cada portada muestra qué personajes se pintaron sin foto de actor ("Prima: sin foto") y el episodio avisa arriba qué personajes no tienen actor con foto, con enlace para asignarlos.
- Registro por imagen en el servidor: con foto / sin foto.
- Instrucción de caras reescrita en positivo (cada cara de referencia es de un solo personaje).
- Los trabajos en segundo plano ya no fallan si la propuesta se borró o archivó mientras se revisaba.

## 0.4.3 — 2026-10-12
- **Todos los actores con foto salen en cada portada** (hasta 4): Claude sabe quién tiene foto, y si deja fuera a alguno Gancho lo agrega solo a la escena.
- Los nombres de personaje se comparan con tolerancia ("La novia" = "Novia"): ningún actor se queda sin su foto de referencia por cómo se escribió su nombre.
- Hasta 4 personas protagonistas por portada; en "Víctima sola" la víctima va al frente y los demás más chicos atrás.

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
