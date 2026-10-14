# Integrar Gancho al ERP de Prismaticoos

> **Actualización v1.0.0:** la instalación vigente está en [`deploy/erp/README.md`](../deploy/erp/README.md) (servidor del ERP, Cloudflare Access, Spaces, módulo «Kit de publicación» en Prisma Studio). Este documento queda como historia de decisiones.

> **Para el Claude Code de Carlitos en la Mac mini** (`carlitos@prisma-server.local`, repo `~/erp`).
> Léelo junto con la Guía de Carlitos (tu `~/.claude/CLAUDE.md`), el `CLAUDE.md` del ERP y `docs/HANDOFF.md` de Gancho.
> Gancho ya trae todo lo necesario de su lado (v0.7.0). Aquí está **qué hacer en el ERP** y **qué decide Luis**.

---

## 0. Antes de empezar (reglas del ERP)

- Trabaja en la rama **`carlitos/gancho`** creada desde un `main` actualizado. Nunca en `main`, nunca `push`.
- Solo datos **ficticios** en localhost. Gancho tiene modo de prueba sin gasto: `NANOBANANA_MOCK=1` (imágenes falsas).
- **Nunca** escribas llaves reales: `GANCHO_SSO_SECRET`, `ANTHROPIC_API_KEY`, `NANOBANANA_API_KEY`, etc. las pega **Luis**.
- Tocar **menú, permisos o login** es núcleo → Carlitos lo consulta con Luis antes (ver §5).
- Entrega con `erp entregar "Social Media: módulo Portadas (Gancho)"` + resumen de 5 líneas a Luis.

## 1. Cómo encaja (arquitectura recomendada)

```
Usuario ──Cloudflare Access──► ERP (sistema.erp-prismaticoos.com)
                                  │ menú Social Media › Portadas
                                  │ 1) ERP valida sesión + permiso
                                  │ 2) ERP firma un token de 60 s
                                  ▼
                       Gancho (portadas.erp-prismaticoos.com) /sso?t=… ──► sesión propia de Gancho
                                  │
                                  └─► bitácora firmada ──► ERP  /api/integraciones/gancho/bitacora
```

- **Gancho sigue siendo un servicio aparte** (su propio repo, su propio Postgres `gancho`, su cola de trabajos y su disco de videos). El ERP **no** copia su código: lo abre y le delega el inicio de sesión. Así no se mezclan bases ni se toca el núcleo de más.
- **Mismo dominio padre** (`*.erp-prismaticoos.com`): la cookie de Gancho funciona dentro del ERP (iframe) sin cambios de seguridad.
- Detrás de **Cloudflare Access** igual que el ERP. Videos largos ya funcionan a través de Cloudflare: Gancho los sube en partes de 64 MB (límite `MAX_VIDEO_GB`, por defecto 20 GB).

## 2. Lo que ya trae Gancho (no hay que programarlo)

| Necesidad del ERP | En Gancho |
|---|---|
| Solo correos @prismaticoos.com | `/sso` rechaza cualquier otro dominio (`ERP_DOMINIO`). |
| Entrar sin otra contraseña | `GET /sso?t=<token>&volver=/#/ruta` crea la sesión. Token de un solo uso, vence en ≤ 2 min, firma HMAC-SHA256. |
| El ERP manda los permisos | El token trae `rol` (`admin` o `editor`); Gancho lo actualiza en cada entrada. |
| Apagar el login propio | `ERP_SOLO=1` (queda solo el `ADMIN_USER` de emergencia). |
| Mostrarse dentro del ERP | `ERP_ORIGENES="https://sistema.erp-prismaticoos.com https://pruebas.erp-prismaticoos.com"` (CSP `frame-ancestors`). |
| Bitácora | Tabla `bitacora` en Gancho + envío firmado al ERP (`ERP_BITACORA_URL`, `ERP_BITACORA_SECRET`): entrar, generar, ajustar, rehacer, crear versiones, lote lanzado, borrar. |
| Gasto de IA > US$5 lo aprueba Luis | `ERP_LIMITE_USD=5`: un editor no puede lanzar más; un administrador sí. Cada botón muestra el costo antes. |
| Historial por persona | Cada usuario ve solo lo suyo; el admin puede ver todo el equipo. |

## 3. Lo que hay que hacer en el ERP (rama `carlitos/gancho`)

### 3.1 Permisos (consultar con Luis — núcleo)
Proponer en el sistema de permisos existente:
- `social.portadas.ver` → ver el módulo.
- `social.portadas.crear` → generar (rol `editor` en Gancho).
- `social.portadas.administrar` → rol `admin` en Gancho (ver todo el equipo, lanzar gastos > US$5, usuarios y canales).

Si el ERP necesita filas nuevas para estos permisos: **migración nueva**, nunca editar una existente.

### 3.2 Menú (consultar con Luis — núcleo)
Social Media (magenta) → **«Portadas (Gancho)»**. Si aún no está aprobado, que salga como «Próximamente».

### 3.3 API del ERP: emitir el token
Ruta protegida por sesión + permiso `social.portadas.ver`. Ejemplo en Node (adaptar al framework y al helper de permisos del ERP):

```js
import crypto from "node:crypto";
// GANCHO_URL y GANCHO_SSO_SECRET vienen del .env del ERP (los pega Luis; nunca en el código).
export function urlEntrarGancho(usuario, volver = "/#/") {
  const datos = Buffer.from(JSON.stringify({
    email: usuario.email,                       // debe ser @prismaticoos.com
    nombre: usuario.nombre,
    rol: usuario.puede("social.portadas.administrar") ? "admin" : "editor",
    exp: Math.floor(Date.now() / 1000) + 60,    // vence en 60 s (Gancho rechaza más de 120 s)
    n: crypto.randomUUID(),                     // un solo uso
  })).toString("base64url");
  const firma = crypto.createHmac("sha256", process.env.GANCHO_SSO_SECRET).update(datos).digest("base64url");
  return `${process.env.GANCHO_URL}/sso?t=${datos}.${firma}&volver=${encodeURIComponent(volver)}`;
}
// GET /api/gancho/entrar → registrar en bitácora del ERP "abrió Portadas" y redirigir (302) a urlEntrarGancho(req.usuario)
```

Pruebas automatizadas mínimas: sin permiso → 403; correo fuera del dominio → no emite; el token vence en 60 s; `rol` sale de `social.portadas.administrar`.

### 3.4 Pantalla del ERP
Página del módulo con un `<iframe>` a `/api/gancho/entrar` (ocupa toda el área de contenido, sin barra propia) o un botón «Abrir Portadas» en pestaña nueva. Nada de `alert`/`confirm`.

### 3.5 Recibir la bitácora
`POST /api/integraciones/gancho/bitacora` (sin sesión de usuario, protegida por firma):

```js
// Verificar ANTES de parsear: firma = HMAC-SHA256(cuerpo crudo, GANCHO_BITACORA_SECRET) en hexadecimal.
const esperada = crypto.createHmac("sha256", process.env.GANCHO_BITACORA_SECRET).update(cuerpoCrudo).digest("hex");
const ok = firma.length === esperada.length && crypto.timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
// cuerpo: { modulo:"gancho", usuario, accion, detalle, ip, cuando } → insertar en la bitácora del ERP con módulo "Social Media · Portadas"
```
Prueba: firma inválida → 401 y no inserta.

## 4. Correr Gancho en la Mac mini (localhost, datos ficticios)

```bash
cd ~ && git clone <repo de Gancho que indique Luis> gancho && cd gancho && npm ci
createdb gancho                                   # Postgres 16 ya existe para el ERP
cp .env.example .env                              # y llenar SOLO valores de prueba:
#   DATABASE_URL=postgres://localhost/gancho
#   PORT=3100   PUBLIC_BASE_URL=http://prisma-server.local:3100
#   NANOBANANA_MOCK=1                             (sin gasto: imágenes de prueba)
#   ERP_SSO_SECRET=<cualquier texto de prueba>   ERP_SOLO=1   ERP_LIMITE_USD=5
#   ERP_ORIGENES=http://prisma-server.local:5175   (el ERP de Carlitos)
#   ANTHROPIC_API_KEY / NANOBANANA_API_KEY: los pone Luis (o se deja el modo de prueba)
npm start                                         # o node server.js
```
En el `.env` del ERP de Carlitos: `GANCHO_URL=http://prisma-server.local:3100` y `GANCHO_SSO_SECRET=<el mismo texto de prueba>`.

## 4b. Nube y escalar (cuando se necesite más velocidad)

- **Contenedor**: `Dockerfile` en la raíz (Node 22, ffmpeg y modelos de caras incluidos). Sirve igual en DigitalOcean (App Platform o Droplet), Render u otra nube.
- **Escalar**: el mismo programa con distintos papeles, compartiendo Postgres y almacenamiento S3/Spaces/R2:
  - `ROLE=web` (1–2 instancias): la interfaz y la API.
  - `ROLE=worker` (las que hagan falta): leen videos, buscan caras, piden imágenes. Más trabajadores = más videos a la vez.
  - Ajustes por trabajador: `VIDEO_CONCURRENCY` (videos a la vez, 1 por cada ~2 GB de RAM), `IMAGE_CONCURRENCY`, `CLAUDE_CONCURRENCY`.
  - La cola (pg-boss) reparte el trabajo sola; el vigilante repara lo que se interrumpa en cualquier instancia.
- **Videos grandes en la nube**: con S3/Spaces/R2 los videos de más de 64 MB suben **en partes directo al bucket** (hasta `MAX_VIDEO_GB`). El bucket debe permitir CORS con `PUT` desde el dominio de Gancho y **exponer el header `ETag`**.
- **Sin nube (Mac mini)**: `ROLE=all`, disco local `DATA_DIR`; los videos suben en partes de 64 MB a través de Cloudflare.

## 4c. Perfiles de actores y hacks (automático)

- Al leer un video, Gancho busca caras en **todo el episodio** (1 cuadro cada ~10 s, máx. `FACE_SCAN_MAX_FRAMES`=180) además de los tramos donde habla cada personaje.
- Reconoce a los actores de la biblioteca; si un personaje principal no está, **crea su perfil** («Personaje (sin nombre)») para renombrarlo una vez.
- Cada video **mejora el perfil**: agrega caras mejores, reemplaza casi-duplicadas peores, ignora caras de otra persona y **borra las que sobran**, conservando variedad (frente, 3/4, perfil). Máximo `CARAS_POR_ACTOR`=24 de episodio; las fotos oficiales nunca se borran.
- **Hacks**: ubica todos los episodios del video (Episodio 1, 2, 3…) por pantallas negras + silencios; portada, título y descripción salen **solo del episodio 1**. Se puede decir cuántos son o dejar que Gancho los cuente; en el episodio se ve la lista y se puede **corregir el corte** («Corregir y volver a leer»). En Manual hay casilla «Es un hack».

## 5. Decisiones para Luis (con recomendación)

1. **Dónde corre Gancho en pruebas/producción** — (A, recomendada) en DigitalOcean junto al ERP, como servicio aparte con su Postgres; (B) seguir en Render; (C) la Mac mini (no recomendado para producción: si se apaga, no hay portadas).
2. **Subdominio** — recomendado `portadas.erp-prismaticoos.com` (pruebas: `portadas-pruebas.…`), detrás de Cloudflare Access.
3. **URL pública para las fotos de actores** — Nano Banana descarga las fotos desde `PUBLIC_BASE_URL/pub/…` (enlaces firmados de 2 h). Con Cloudflare Access delante, **excluir de Access solo `/pub/*` y `/api/nb-callback/*`** (ya van firmadas), o usar almacenamiento S3/R2/Spaces de DigitalOcean (recomendado en producción).
4. **Proveedor de imágenes** — la política del ERP dice «imagen y video con Higgsfield»; Gancho usa **Nano Banana Pro** porque dio el mejor parecido con los actores en pruebas. Opciones: (A, recomendada) mantener Nano Banana para portadas; (B) agregar Higgsfield como proveedor en `src/ai/imagen.js` y comparar.
5. **Permisos y menú** de §3.1–3.2.
6. **Repositorio** — Gancho está en `github.com/Asalex35/gancho` (privado). ¿Se transfiere a la organización de Prismaticoos para que Luis lo administre?
7. **Llaves** — Luis pega `ANTHROPIC_API_KEY`, `NANOBANANA_API_KEY`, `ELEVENLABS_API_KEY`, `YOUTUBE_API_KEY`, `ERP_SSO_SECRET` (=`GANCHO_SSO_SECRET`) y `ERP_BITACORA_SECRET` (=`GANCHO_BITACORA_SECRET`). Rotar las que se compartieron en chats.

## 6. Resumen para la entrega a Luis (plantilla)

1. Qué hace: Social Media › Portadas abre Gancho con inicio de sesión del ERP (sin otra contraseña) y registra todo en la bitácora.
2. Pantallas: entrada de menú «Portadas (Gancho)» y su página.
3. Migración: permisos `social.portadas.*` (nueva).
4. Cómo probar: entrar con usuario demo editor y admin; editor no puede lanzar > US$5; firma inválida de bitácora → 401.
5. Pendientes: decisiones de §5.
