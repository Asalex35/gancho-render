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
5. **Settings → Custom Domain** en `gancho-web` y crea el CNAME que te indique Render.

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
