# Gancho by Prismáticoos — documento de entrega

> Para el equipo o el asistente que va a llevar Gancho al **ERP de Prismáticoos** y correrlo en la **Mac mini**.
> Estado al 14 oct 2026 · versión **v0.8.0** · repo privado `github.com/Asalex35/gancho` (rama `main`, etiquetas `v0.1.0`…`v0.6.2`, historial en `CHANGELOG.md`).
> Este documento no contiene llaves ni contraseñas: viven en `.env` (local) y en `/etc/gancho/gancho.env` del servidor.
>
> **Actualización 2026-10-14 (v1.0.0):** Gancho va a producción en el ERP de Prismaticoos (Prisma Studio › Kit de publicación). La guía vigente es [`deploy/erp/README.md`](../deploy/erp/README.md); Render queda solo hasta mudar los datos.

---

## 1. Qué es

Herramienta web interna para el equipo de marketing de Prismáticoos (productora mexicana de melodramas de un episodio, ~10 canales de YouTube: Cuando Los Ángeles Caen, Andy Torres, Prisma TV, Yosuani Flores…). Hace, a partir de la historia de un episodio y las fotos de sus actores:

- **3 propuestas de portada + título para YouTube**, cada una con calificación y por qué funcionaría, al estilo viral de CLAC / Andy Torres.
- **Paquete de publicación**: descripción, tags, hashtags y 2 títulos A/B.
- **Versiones para otras plataformas**: TikTok/Reels 9:16 (estilo apps de series tipo DramaShorts, con título grande), Instagram 4:5, Facebook 1:1, y para **Prisma Plus** (la app de la empresa) póster de película 2:3 y banner 16:9, nivel cine.
- **Vista previa "Así se ve en YouTube"** en computadora, celular y TV, rodeada de tendencias de México o resultados de búsqueda reales.
- Caras **parecidas a los actores reales** (biblioteca de rostros por actor + medición objetiva del parecido).

Usuarios: equipo no técnico, en español, algunos con TDAH → **pocos clics, textos cortos, costos visibles antes de gastar**.

## 2. Cómo se usa (flujos)

| Flujo | Dónde | Qué hace |
|---|---|---|
| **Manual** | `#/nuevo` | Formulario en 3 pasos: 1) la historia, 2) quiénes salen (actor con foto + papel), 3) **¿para dónde es?** (YouTube, TikTok, Instagram, Facebook, póster o banner de Prisma Plus; si no se marca YouTube no se hace la de YouTube). Lo demás (giro, escena, edad, ropa…) es opcional: Gancho lo deduce. |
| **Automático** | `#/auto` | Se sube el video final. Gancho saca cuadros, transcribe (máx. 25 min: inicio/medio/final), detecta caras (~5 min de video), reconoce a los actores de la biblioteca y escribe la historia sola. Opción **"Es un hack"** (recopilación de varios episodios): detecta el corte del 1er episodio (pantalla negra + silencio, o minuto escrito a mano) y usa solo ese. |
| **Lote masivo** | `#/lote/nuevo` | CSV / pegar desde hoja de cálculo (columnas en es/en/pt), revisión previa con créditos estimados, "elegir las mejores" automático y exportar ZIP. |
| **Episodio** | `#/ep/:id` | Tarjetas por propuesta: Elegir/Aprobar, **✎ Ajustar** (edita la misma imagen con cambios puntuales), Rehacer (otra idea con razones), Anteriores (historial/restaurar), ▶ Ver en YouTube, ⬇ Descargar 1280×720, ✦ Redes y Prisma Plus. Etiquetas de parecido por actor, avisos de personajes sin foto, motivo claro si algo falla. |
| **Prisma Plus** | `#/prisma` | Galería de pósters y banners de cine. |
| **Actores** | `#/actores` | Biblioteca de actores con fotos; muestra cuántas caras útiles tiene cada uno. |
| **Canales / Administración** | `#/canales`, `#/admin` | Voz y estilo por canal, idioma (es/en/pt), logo, aprobación automática, webhook (Slack/Chat/Discord); usuarios, uso, proveedores. |

Historial **por perfil**: cada usuario ve solo lo suyo; el admin tiene el interruptor "Solo lo mío / Todo el equipo".

## 3. Arquitectura

- **Node 22 + Express 4**, frontend **vanilla JS** sin build (`public/assets/app.js`, todo con `textContent`, sin `innerHTML`).
- **Postgres 16** + **pg-boss 12** (cola de trabajos dentro de Postgres). Un solo proceso hace web + workers (`ROLE=all`); se puede separar (`ROLE=web` / `ROLE=worker`, requiere S3).
- **Almacenamiento**: disco local (`DATA_DIR`) o S3/R2/Supabase (`S3_*`). Carpetas: `actores portadas mini logos videos cuadros rostros formatos`.
- **IA**:
  - Claude (`@anthropic-ai/sdk`, salidas estructuradas con zod): **Sonnet** para lo creativo (propuestas, títulos, leer el video, diseñar formatos) y **Haiku** para lo mecánico (descripción, tags, revisión de portadas). Configurable con `CLAUDE_MODEL` / `CLAUDE_MODEL_CREATIVO`.
  - Imágenes: **Nano Banana Pro** vía `nanobananaapi.ai` (tareas asíncronas + consulta + callback). Respaldos opcionales: Google Gemini directo y fal.ai Seedream (cortacircuitos tras 3 fallas).
  - Transcripción: **ElevenLabs Scribe** (con hablantes); respaldo compatible OpenAI/Groq.
  - Caras: **onnxruntime-node local** con YuNet (detección) y SFace (huella de 128 números) en `modelos/` (licencias MIT/Apache en `modelos/LEEME.md`). Parecido: coseno ≥0.45 = mismo actor.
- **Video**: `ffmpeg-static` (incluido, no se instala aparte), blindado: formato forzado por extensión y protocolos limitados.

### Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `server.js` | Arranque: migra esquema, siembra canales/usuarios, inicia cola, web y workers. |
| `src/config.js` | Toda la configuración por variables de entorno. |
| `src/schema.sql` | Esquema (idempotente; se aplica solo si cambia su hash). |
| `src/web.js` | Rutas HTTP, seguridad (CSP, CSRF por header `X-Gancho`, límites, dueño por recurso). |
| `src/auth.js` | Usuarios en Postgres (scrypt), cookie firmada `gancho_sesion` (12 h), roles admin/editor. |
| `src/jobs.js` | Colas y trabajos: `ingesta propuestas imagen revisar evaluar rehacer paquete formato limpieza vigilante`. |
| `src/ai/claude.js` | Prompts y esquemas: propuestas, rehacer, evaluar portada, paquete, analizar video, diseñar formato. |
| `src/ai/playbook.js` | Reglas editoriales (fórmulas de título, composición, luz, seguridad de marca) + canales semilla. |
| `src/ai/nanobanana.js`, `imagen.js`, `respaldos.js` | Proveedores de imagen y cadena de respaldo. |
| `src/ai/motivos.js` | Traduce errores técnicos a motivos claros ("la IA no quiso porque…", "sin créditos"…). |
| `src/formatos.js` | Especificación de TikTok / Instagram / Facebook / Prisma Plus. |
| `src/caras.js`, `src/biblioteca.js` | Detección/huella de caras y biblioteca por actor. |
| `src/video.js`, `src/transcribir.js` | ffmpeg (cuadros, audio, corte de hacks) y transcripción. |
| `src/competencia.js` | YouTube Data API (tendencias MX, búsqueda) + RSS/oEmbed. |
| `src/lotes.js`, `src/imagenes.js`, `src/storage.js`, `src/notificar.js`, `src/repo.js`, `src/db.js`, `src/contexto.js` | Lotes CSV, sharp (portada final, aclarado automático), almacenamiento, avisos, consultas, BD, señales/semáforos. |

### Base de datos (tablas)
`usuarios, canales, actores, actor_caras, lotes, episodios, propuestas, versiones, feedback, uso, competencia, formatos` (+ esquema `pgboss` de la cola).

### Rutas principales (todas bajo login salvo `/login`, `/salud`, `/pub/*` firmados y el callback)
`/api/me`, `/api/episodios[/:id]` (+ `/generar`, `/formatos`, `/portada.jpg`, `/paquete`, `/portada-propia`), `/api/propuestas/:id/{elegir,rehacer,ajustar,reintentar,restaurar,versiones,formatos}`, `/api/formatos/{tipos,:id/descargar}`, `/api/prisma`, `/api/lotes/*`, `/api/auto/*` (subida en 2 pasos con firma), `/api/actores/*`, `/api/canales`, `/api/competencia[/youtube]`, `/api/admin/*` (usuarios, canales, uso, diagnóstico de cola).

## 4. Calidad y reglas que costaron trabajo (no perderlas)

- **Perfiles de actores automáticos** y **hacks con todos los episodios**: ver `docs/INTEGRACION-ERP.md` §4c. **Nube/escalar**: §4b.

- **Títulos**: sin edades ni nombres propios (arquetipos: madre, novia, millonario), 45–70 caracteres, no describen la portada ni revelan el final. Con Haiku salían narrativos → por eso lo creativo va con Sonnet.
- **Caras**: todos los actores con foto salen en cada portada (hasta 4); cada cara de referencia es de un solo personaje (evita "dos Yosuanis"); los personajes sin foto llevan rasgos distintos; nombres de personaje comparados con tolerancia ("La novia" = "Novia").
- **Fotos de actores**: filtros suaves para fotos oficiales (las retocadas se descartaban); búsqueda con zoom si la cara es chica.
- **Luz**: portadas claras y saturadas (la competencia promedia ~116/255 de luz); aclarado automático si sale oscura.
- **Seguridad de marca**: adultos con pareja nunca con algo que parezca uniforme escolar; nada de desnudos/sangre; temas de salud con cuidado.
- **Revisión automática**: Claude califica la imagen + medición local de parecido; repinta 1 vez si no se parece o si una cara sale duplicada (solo si hay créditos confirmados; si falla, conserva la anterior).
- **Robustez**: si el servidor se reinicia a mitad de una imagen pagada, se retoma; el vigilante (cada 5 min) libera trabajos atorados; nada se queda "pintando" para siempre.
- **Costos**: Nano Banana Pro ≈ 18 créditos por imagen (1K, ~$0.09); se muestra el costo en cada botón y se pide confirmar.

## 5. Servicios externos y variables de entorno (solo nombres)

| Servicio | Variables | Notas |
|---|---|---|
| Base de datos | `DATABASE_URL` | Postgres 16. |
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_MODEL`, `CLAUDE_MODEL_CREATIVO` | Por defecto Haiku / Sonnet. |
| Nano Banana | `NANOBANANA_API_KEY`, `PRO_RESOLUTION`, `IMAGE_RESOLUTION`, `CREDITS_PER_IMAGE` | **Necesita poder descargar las fotos de los actores por URL pública** (ver §6). |
| Respaldos de imagen | `GOOGLE_API_KEY`, `FAL_KEY`, `IMAGE_PROVIDERS` | Opcionales. |
| ElevenLabs | `ELEVENLABS_API_KEY` (+ `TRANSCRIBE_*` para respaldo) | Usa los créditos del plan de Carlos. |
| YouTube Data API | `YOUTUBE_API_KEY` | Proyecto Google Cloud "prisma-promos", llave "Gancho YouTube" restringida a esa API. 10,000 unidades/día. |
| App | `PUBLIC_BASE_URL`, `SESSION_SECRET`, `LINK_SECRET`, `CALLBACK_SECRET`, `ADMIN_USER`, `ADMIN_PASSWORD`, `ROLE`, `DATA_DIR` o `S3_BUCKET/S3_ENDPOINT/S3_REGION/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY` | |
| Límites/ajustes | `DAILY_IMAGE_LIMIT`, `ORG_DAILY_IMAGE_LIMIT`, `MAX_EPISODES_PER_BATCH`, `CLAUDE_CONCURRENCY`, `IMAGE_CONCURRENCY`, `POLL_CONCURRENCY`, `VIDEO_CONCURRENCY`, `VIDEO_RETENTION_DAYS`, `TRANSCRIBE_MAX_MINUTES` (25), `FACE_SCAN_SECONDS` (300), `NOTIFY_WEBHOOK_URL` | Ver `.env.example`. |

## 6. Llevarlo a la Mac mini (pasos y cuidados)

1. **Requisitos**: Node ≥ 22.12, Postgres 16 (Homebrew), git. ffmpeg y los modelos de caras ya vienen en el repo/dependencias.
2. `git clone` del repo privado → `npm ci` → crear `.env` a partir de `.env.example` (las llaves las pega una persona, no se comparten en chats).
3. `DATA_DIR` en un disco con espacio (videos 4K se borran solos a los `VIDEO_RETENTION_DAYS`).
4. **Punto crítico — URL pública**: Nano Banana descarga las fotos de los actores desde `PUBLIC_BASE_URL/pub/...` (enlaces firmados que caducan en 2 h) y manda su aviso a `/api/nb-callback/...`. Si la Mac mini no es accesible desde internet, **las portadas no se parecerán a los actores**. Opciones: **Cloudflare Tunnel con nombre fijo** (recomendado; un túnel temporal `trycloudflare` cambia de URL en cada arranque), o guardar las imágenes en **S3/R2** (entonces las fotos salen por URL firmada del bucket).
5. Mantenerlo vivo: `launchd` (o pm2) con reinicio automático; que la Mac no se duerma (`caffeinate` / Ajustes de energía). El arranque hace las migraciones solo.
6. **Migrar datos de Render**: Administración › Descargar respaldo y `npm run importar -- archivo --renombrar viejo=nuevo` en el servidor nuevo (ver `deploy/erp/README.md` §9). Después apagar Render (~$36 USD/mes).
7. Respaldos diarios: `pg_dump` + copia de `DATA_DIR`.

## 7. Integración con el ERP — ver `docs/INTEGRACION-ERP.md` (paso a paso para el Claude de la Mac mini)

Resumen de opciones:

- **A. Módulo enlazado (lo más rápido)**: Gancho sigue como servicio propio; el ERP lo abre en su dominio/subruta detrás del mismo proxy. Si se quiere dentro de un **iframe**, cambiar la CSP `frame-ancestors 'none'` (en `src/web.js`) por el origen del ERP y revisar la cookie (`sameSite`).
- **B. Inicio de sesión único**: que el ERP mande al usuario ya autenticado (p. ej. token firmado compartido) y Gancho cree/abra su sesión; hoy los usuarios viven en la tabla `usuarios` con rol `admin`/`editor`.
- **C. API**: el ERP puede usar las rutas JSON de §3 (requieren la cookie de sesión y el header `X-Gancho: 1` en métodos que escriben).
- Mantener: un solo Postgres por instancia de Gancho, el historial por perfil y los límites diarios de imágenes.

## 8. Dónde está hoy

- Producción: **ERP de Prismaticoos** (`portadas.erp-prismaticoos.com`, lo instala Luis con `deploy/erp/`). Mientras tanto sigue en Render (`https://gancho-p4ns.onrender.com`) solo para no dejar al equipo sin herramienta; se apaga al mudar los datos.
- Usuarios activos: carlos (admin), anapau, enrique.
- Créditos Nano Banana al cierre: ~150 (≈ 8 imágenes) → **recargar**.

## 9. Pendientes y recomendaciones

- **Rotar las llaves** de Claude y Nano Banana (se compartieron en chats durante el desarrollo).
- Recargar créditos de Nano Banana.
- Aprendizaje con datos reales de YouTube (Reporting API de clics, prueba A/B): investigado, no construido.
- Subtítulos SRT en varios idiomas y capítulos: pedidos, no construidos.
- Títulos/descripciones localizados EN/PT para canales en otros idiomas: el soporte de idioma por canal existe; falta la traducción de los textos dentro de las imágenes de redes.

## 10. Cómo trabajar con Carlos (preferencias)

- Responder **siempre en español**, **corto**, una idea por línea, pocas preguntas (tiene TDAH).
- Puede pedir "hazlo tú": hacer todo lo posible, pero contraseñas, tarjetas y llaves en páginas web las pone él.
- Nada de logos de patrocinadores en portadas salvo que lo pida.
