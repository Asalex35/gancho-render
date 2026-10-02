# Gancho · by Prismáticoos

Portadas, títulos, descripción y tags para YouTube, de uno en uno o por lotes de cientos.
Claude escribe y califica; Nano Banana pinta.

## Cómo funciona
```
Navegador ──► Web (Express) ──► Postgres ◄── Worker(s)
                                  │  cola de trabajos (pg-boss)
                                  ▼
                 propuestas → imagen → revisar → evaluar → paquete
                  (Claude)  (Nano B.)  (Nano B.)  (Claude)  (Claude)
Imágenes: disco local o Cloudflare R2 / S3
```
- Cada paso es un trabajo con reintentos. Si Claude o Nano Banana se saturan, reintenta solo.
- Lo que se pide desde la pantalla de un episodio va antes que los lotes (prioridad).
- Para ir más rápido: sube `IMAGE_CONCURRENCY` o agrega más workers en Render.

## Tres formas de trabajar
1. **Automático:** subes el video final y Gancho saca cuadros, transcribe, entiende la historia, toma las caras del propio video,
   hace 3 portadas y las califica. Si el canal tiene aprobación automática y la mejor pasa el umbral, queda lista sola; si no, avisa por Slack/Chat/Discord.
2. **Lote masivo:** pegas una lista de sinopsis desde Sheets.
3. **Manual:** un episodio con su historia y cast.

Cada canal tiene idioma (español, inglés, portugués), voz, estilo visual, títulos de ejemplo, textos fijos y reglas de aprobación.
Los títulos se escriben como nativo del país y la interfaz muestra la traducción al español.

## Rostros parecidos a los actores
- Cada actor tiene una **biblioteca de rostros**: sus fotos subidas + las mejores caras de cada episodio (máx. 40).
- En el flujo automático, Gancho agrupa las caras del video por persona, **reconoce al actor** contra la biblioteca
  y, con la historia, decide qué personaje es. Si no lo conoce, lo crea como "Sin nombre" para renombrarlo una vez.
- Referencias para Nano Banana Pro: cara del episodio (frente y 3/4), medio cuerpo y las mejores caras de la biblioteca.
- Cada portada se mide contra la cara real del actor (parecido alto / medio / bajo). Si sale bajo, se vuelve a pintar.

## Si algo falla
- **Nano Banana caído o sin créditos:** Gancho pasa solo a Google (mismo modelo, directo) y luego a Seedream, y avisa al equipo.
  Tras 3 fallas en 5 min deja de intentar con ese proveedor por 5 min.
- **Trabajos interrumpidos** (deploy, caída del worker): el "vigilante" corre cada 5 min y repara o marca para reintentar.
- **Sin cobros dobles:** cada imagen se "reclama" antes de pedirla; el cupo diario se reserva de forma atómica.

## Correr en tu Mac
```
brew services start postgresql@16
npm install
npm start                     # http://localhost:3000
NANOBANANA_MOCK=1 npm start   # imágenes falsas, no gasta créditos
```

## Publicar en Render
1. Sube el repo a GitHub (privado). El `.env` no se sube.
2. Crea un bucket en Cloudflare R2 y una API key con permiso de lectura y escritura.
3. Render → **New → Blueprint** → elige el repo (`render.yaml` crea web, worker y Postgres).
4. Llena las variables marcadas: keys de Claude y Nano Banana, `ADMIN_USER`, `ADMIN_PASSWORD`, `PUBLIC_BASE_URL` y las de R2.
5. En el bucket de R2 → **Settings → CORS**: permite `PUT` desde tu dominio (para subir videos directo al bucket).
6. `ELEVENLABS_API_KEY` para transcribir (máx. 40 min por episodio) y saber quién habla; con eso el detector de caras
   (local, gratis, revisa ≈5 min del video) recorta la cara y el medio cuerpo de cada personaje. Respaldo opcional: `TRANSCRIBE_API_KEY` (Groq/OpenAI).
7. **Settings → Custom Domain** en `gancho-web` y crea el CNAME que te indique Render.

Más barato para empezar: un solo servicio web con `ROLE=all` + Postgres (sin R2, con disco persistente en `DATA_DIR`).

## Seguridad
- Las API keys solo viven en el servidor.
- Usuarios con rol (admin/editor), contraseñas con scrypt, límite de intentos de login.
- Cookie firmada `httpOnly`; cambiar la contraseña cierra las sesiones viejas.
- Protección CSRF, CSP y HSTS. Las fotos se validan por contenido y se les quitan los metadatos (GPS).
- Nano Banana lee las fotos del cast con enlaces firmados que caducan en 2 horas.
- Límites diarios por persona y por equipo, y estimación de créditos antes de lanzar un lote.

## Dónde se edita el "cerebro"
- `src/ai/playbook.js`: fórmulas de título y reglas de portada.
- Administración → Canales: voz, descripción fija, disclaimer, hashtags y logo de cada canal.
