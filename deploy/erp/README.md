# Kit de publicación (Gancho) en el servidor del ERP · guía de instalación para Luis

Gancho hace portadas, títulos, descripciones y tags (YouTube, TikTok, Instagram, Facebook y Prisma Plus) a partir del
video o la sinopsis de un episodio, con las caras reales de los actores. En el ERP aparece en un apartado nuevo, **Prisma Studio › Kit de publicación**: el módulo `portadas` del ERP (rama
`carlitos/portadas`) da el espacio del menú, el permiso, el botón «Abrir Kit de publicación» y la bitácora; Gancho corre como un servicio aparte en el mismo servidor, en su propio subdominio y detrás del mismo
Cloudflare Access.

```
ERP (sistema.erp-prismaticoos.com) ── «Abrir Kit de publicación» ──> token de un solo uso (HMAC, ≤ 2 min, @prismaticoos.com)
                                                               │
navegador ──HTTPS──> Cloudflare (Access: correo + código) ──túnel──> nginx 127.0.0.1:8082 ──> Gancho 127.0.0.1:8090
                                                                                              ├─> PostgreSQL: base «gancho» (propia)
                                                                                              └─> Spaces: imágenes y videos
Gancho ──(firmado)──> POST sistema.erp-prismaticoos.com/api/portadas/bitacora  (cada acción a la bitácora del ERP)
```

Tiempo estimado: 1 a 2 horas. Lo que se probó antes de entregar está en «12. Cómo comprobar que todo funciona».

---

## 0. Decisiones para Luis (antes de instalar)

| # | Tema | Lo que hace hoy Gancho | Recomendación |
|---|---|---|---|
| 1 | **Proveedor de imágenes** (el ERP dice «imagen con Higgsfield») | Google oficial (Gemini · Nano Banana Pro) → respaldo nanobananaapi.ai → fal.ai. El parecido con los actores sale de mandar varias fotos de referencia por actor, que es lo que hace Nano Banana Pro. | Aprobar Google como excepción para portadas. ≈ US$0.134 por imagen (1K/2K). |
| 2 | **Puerta de IA** | Gancho es un sistema aparte: llama a Claude, Google, ElevenLabs y YouTube con sus propias llaves (en `/etc/gancho/gancho.env`, solo Luis las pega). | Aceptarlo así en esta fase. Cada acción queda en la bitácora del ERP; topes: `ERP_LIMITE_USD=5` por trabajo y límite diario de portadas por persona y por equipo. Más adelante se puede pasar por `pedirTrabajo`. |
| 3 | **Base de datos** | Base y usuario **propios** (`gancho`) en el mismo clúster `erp-db-produccion`. No toca tablas del ERP. | Así. |
| 4 | **Archivos** | DigitalOcean Spaces, bucket `prismaticoos-gancho-prod` (videos de hasta 30 GB que se borran solos a los 3 días). | Spaces. En disco local un video de 30 GB no cabe con holgura. |
| 5 | **Quién entra** | Solo desde el ERP (`ERP_SOLO=1`), con `Kit de publicación` › crear. › aprobar = administrador. | Darlo a Social Media / Marketing. |

---

## 1. Usuario y código

```bash
sudo useradd --system --create-home --home-dir /var/lib/gancho --shell /usr/sbin/nologin gancho
sudo install -d -o gancho -g gancho -m 755 /var/www/gancho
sudo install -d -o gancho -g gancho -m 750 /var/lib/gancho/datos
sudo -u gancho ssh-keygen -t ed25519 -N "" -C "erp-produccion gancho (solo lectura)" -f /var/lib/gancho/.ssh/github_deploy
sudo -u gancho cat /var/lib/gancho/.ssh/github_deploy.pub
```

Registra esa llave como **deploy key de solo lectura** en el repositorio de Gancho (`Asalex35/gancho`, privado; Carlos
te da acceso o lo transfiere a la organización `prismaticoos`). Luego:

```bash
sudo -u gancho git -c core.sshCommand="ssh -i /var/lib/gancho/.ssh/github_deploy" clone git@github.com:Asalex35/gancho.git /var/www/gancho
sudo -u gancho git -C /var/www/gancho config core.sshCommand "ssh -i /var/lib/gancho/.ssh/github_deploy"
cd /var/www/gancho && sudo -u gancho git checkout v1.0.0 && sudo -u gancho npm ci --omit=dev
```

Node 22 ya está instalado para el ERP. ffmpeg y los modelos de caras vienen en el paquete: no hay que instalar nada más.

## 2. Base de datos

**Producción** (clúster `erp-db-produccion`): panel → *Users & Databases* → crea la base `gancho` y el usuario `gancho`.
Con `doadmin`, desde el servidor (sin guardar su cadena):

```sql
\c gancho
GRANT CONNECT, TEMPORARY ON DATABASE gancho TO gancho;
GRANT USAGE, CREATE ON SCHEMA public TO gancho;
```

Gancho crea y actualiza sus tablas al arrancar (y su cola `pgboss`). La cadena va por la VPC con el mismo certificado del
ERP (`/etc/erp/do-ca-produccion.crt`, `sslmode=verify-full`); Gancho verifica el certificado y el nombre del servidor.

**Pruebas** (PostgreSQL local): `sudo -u postgres createuser gancho && sudo -u postgres createdb -O gancho gancho`
y `DATABASE_URL=postgresql:///gancho?host=/var/run/postgresql`.

## 3. Spaces (archivos)

1. Panel → Spaces → crea `prismaticoos-gancho-prod` (misma región que el servidor; privado, sin CDN).
2. *Access keys* → llave **limitada a ese bucket** (lectura y escritura).
3. CORS (los videos suben directo del navegador al bucket, en partes) y ciclo de vida (red de seguridad: videos a los
   4 días y subidas abandonadas al día):

```bash
cd /var/www/gancho/deploy/erp
aws s3api put-bucket-cors --endpoint-url https://<región>.digitaloceanspaces.com --bucket prismaticoos-gancho-prod --cors-configuration file://spaces-cors.json
s3cmd setlifecycle spaces-ciclo-de-vida.xml s3://prismaticoos-gancho-prod
```

## 4. Variables

```bash
sudo install -d -o root -g gancho -m 750 /etc/gancho
sudo install -o root -g gancho -m 640 /var/www/gancho/deploy/erp/gancho.env.example /etc/gancho/gancho.env
sudo nano /etc/gancho/gancho.env
```

- Secretos nuevos con `openssl rand -hex 32`: `SESSION_SECRET`, `LINK_SECRET`, `CALLBACK_SECRET`, y otros dos para
  `ERP_SSO_SECRET` y `ERP_BITACORA_SECRET` (esos dos van también en `/etc/erp/erp.env` como `GANCHO_SSO_SECRET` y
  `GANCHO_BITACORA_SECRET`).
- `DATABASE_URL`: escríbela con `read -rs`, como la del ERP, para que no quede en el historial.
- Llaves de IA: Anthropic, Google (Generative Language API **con facturación activa**: las imágenes no tienen capa
  gratis), ElevenLabs y YouTube Data API v3.
- Sin comillas y sin comentarios al final de la línea (systemd los tomaría como parte del valor).

## 5. Servicio

```bash
sudo cp /var/www/gancho/deploy/erp/gancho.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now gancho
curl -fsS http://127.0.0.1:8090/salud     # {"ok":true}
sudo journalctl -u gancho -n 50
```

## 6. nginx

```bash
sudo cp /var/www/gancho/deploy/erp/nginx-gancho.conf /etc/nginx/sites-available/gancho
sudo ln -s /etc/nginx/sites-available/gancho /etc/nginx/sites-enabled/gancho
sudo nginx -t && sudo systemctl reload nginx
```

Usa el `map $ip_visitante` que ya tiene el `nginx.conf` del ERP. Escucha solo en `127.0.0.1:8082`.

## 7. Cloudflare

1. **Túnel**: agrega la ruta de `cloudflared-ingress.yml` en `/etc/cloudflared/config.yml` (antes de la regla final 404),
   `cloudflared tunnel route dns <túnel> portadas.erp-prismaticoos.com` y `sudo systemctl restart cloudflared`.
2. **Access**: si la aplicación del ERP ya cubre `*.erp-prismaticoos.com`, protege también `portadas.`; si no, crea una
   aplicación para `portadas.erp-prismaticoos.com` con la **misma política** (el grupo que sincroniza el ERP). Copia su
   *Application Audience (AUD) Tag* a `CF_ACCESS_AUD` y el team domain a `CF_ACCESS_TEAM`. Gancho verifica la firma del
   pase de Access en cada petición: quien llegue sin pasar por Cloudflare ve «Gancho solo se abre desde el ERP».
3. **Bitácora hacia el ERP**: `sistema.erp-prismaticoos.com` está detrás de Access, así que Gancho llega con un
   *service token*: Zero Trust → Access → Service Auth → crea «gancho-bitacora» y, en la aplicación del ERP, una política
   «Service Auth» que lo permita **solo** para la ruta `/api/portadas/bitacora` (aplicación por ruta). Su Client ID y
   Client Secret van en `ERP_BITACORA_CF_ID` y `ERP_BITACORA_CF_SECRET`. Gancho manda además `Origin` del ERP (el núcleo
   rechaza POST de otro origen) y firma cada evento con `ERP_BITACORA_SECRET`; el ERP rechaza firma mala, eventos de más
   de 5 min y repetidos.
4. Nada de Gancho necesita «Bypass»: Google recibe las fotos de los actores dentro de la petición y los respaldos las
   leen de Spaces con ligas firmadas.

## 8. ERP

1. Integra la rama `carlitos/portadas` (módulo `portadas`: espacio «Prisma Studio» en el menú —commit de núcleo aparte
   para tu visto bueno—, permiso «Kit de publicación», `POST /api/portadas/entrar` y `POST /api/portadas/bitacora`; su
   `docs/portadas/README.md` lo explica). Copia de los parches en `deploy/erp/modulo-erp/`.
2. En `/etc/erp/erp.env`: `GANCHO_URL=https://portadas.erp-prismaticoos.com`, `GANCHO_SSO_SECRET`, `GANCHO_BITACORA_SECRET`;
   reinicia `erp-api`. Sin esas variables la pantalla dice que el Kit de publicación aún no está conectado.
3. Usuarios y roles → `Kit de publicación` › crear para quien hace portadas, › aprobar para quien lo administra.

## 9. Mudar los datos que hoy están en Render

En Render ya hay actores, perfiles de caras, historial y portadas. Para traerlos:

1. Carlos (administrador del Gancho de Render) → **Administración › Descargar respaldo**
   (`gancho-respaldo-AAAA-MM-DD.tar.gz`: tablas en JSON + imágenes, sin videos).
2. Súbelo al servidor por un canal seguro (`scp`) y cárgalo **en la base nueva**, cambiando los usuarios viejos por los
   del ERP (la parte antes de @ del correo):

```bash
cd /var/www/gancho
sudo -u gancho node --env-file=/etc/gancho/gancho.env scripts/importar.js /tmp/gancho-respaldo.tar.gz \
  --renombrar carlos=carlos.ortiz,anapau=<usuario-de-ana>,enrique=<usuario-de-enrique>
shred -u /tmp/gancho-respaldo.tar.gz
```

   Si la base ya tiene episodios se niega, para no duplicar.
3. Cuando todo funcione en el ERP, Carlos apaga Render.

## 10. Almacenamiento (para no saturar)

Limpieza diaria automática (los días se cambian en `gancho.env`):

| Qué | Se borra a los |
|---|---|
| Videos originales | 3 días (Spaces además a los 4, por ciclo de vida) |
| Transcripciones y subtítulos (texto en la base) | 7 días |
| Cuadros del video que no usa el reparto ni la portada | 14 días |
| Propuestas reemplazadas por «3 nuevas» y «Anteriores» viejas (siempre quedan las 3 últimas) | 30 días |
| Propuestas que no se eligieron | a los 60 días quedan solo en miniatura |
| Versiones de redes que fallaron | 7 días |

Nunca se borra: la portada elegida, las versiones de redes y Prisma Plus listas, las fotos de actores ni sus perfiles.
Las imágenes se guardan en JPG (1920 px YouTube, 2400 px redes). Administración › Almacenamiento muestra cuánto ocupa
cada cosa; si el disco local pasa del 85 % avisa por `NOTIFY_WEBHOOK_URL`.

## 11. Actualizar

```bash
sudo /var/www/gancho/deploy/erp/desplegar.sh v1.0.1   # o sin etiqueta = lo último de main
```

Trae la versión, instala, corre la revisión completa y solo entonces reinicia. Si algo falla (instalar, revisar o que no
responda en 60 s), regresa solo a la versión anterior y la deja corriendo. Ojo: la revisión aplica los cambios de tablas
de la versión nueva (siempre son aditivos, la versión anterior sigue funcionando con ellos). El `CHANGELOG.md` dice qué trae cada versión.

## 12. Cómo comprobar que todo funciona

```bash
cd /var/www/gancho && sudo -u gancho NODE_ENV=production node --env-file=/etc/gancho/gancho.env scripts/verificar.js
```

Revisa sin gastar: Node y memoria, variables, conexión con el ERP y Cloudflare Access, base con TLS (crea las tablas),
Spaces (escribe, lee y borra), ffmpeg, modelos de caras y que cada llave de IA responda (Claude, Google y sus modelos de
imagen, Nano Banana, ElevenLabs, YouTube). Contesta con ✅ / ⚠️ / ❌ en español y sale con error si falta algo obligatorio.

Prueba de punta a punta (≈ US$0.50):

1. ERP › Prisma Studio › Kit de publicación › **Abrir** → entra ya con sesión; arriba dice «Kit de publicación · Prisma Studio».
2. Abre `https://portadas.erp-prismaticoos.com/login` en una ventana privada → Cloudflare pide el correo y, ya dentro,
   el login con contraseña está apagado (`ERP_SOLO=1`).
3. **Manual**: sinopsis corta + 1 actor con foto → 3 portadas y títulos en ~1 min, con solo ese actor en la imagen.
4. Elegir una → «Cómo se ve en YouTube» (computadora, TV y celular entre portadas reales) → Descargar.
5. **Video**: subir un MP4 corto → detecta caras, crea el perfil del actor, transcribe y propone.
6. Bitácora del ERP → la apertura, la entrada y las portadas generadas.
7. Administración (con `Kit de publicación` › aprobar) → gasto del día, Almacenamiento y Bitácora.

Probado en local antes de entregar: la revisión completa; el respaldo (exportar → importar en una base vacía con
renombre de usuarios, y que se niegue a importar dos veces); el pase de Cloudflare (válido entra; de otra aplicación, otra
organización, vencido, alterado o con `alg: none` se rechaza); con Access activo, `/salud` responde y todo lo demás pide
el pase. De versiones anteriores: token del ERP reusado, de otro dominio, vencido o con firma falsa → rechazado; rutas con
mayúsculas para saltarse el dueño → 404; subida sin firma o video falso → rechazados; lote de más de US$5 por un editor
→ bloqueado; cada usuario ve solo su historial.

## 13. Respaldos y llaves

- La base `gancho` entra en los respaldos automáticos del clúster; conviene sumarla al respaldo diario cifrado del ERP
  (`deploy/respaldo/`). Las imágenes viven en Spaces (activa versionado si quieres poder deshacer borrados).
- Las llaves que usó el Gancho de Render pasaron por chats: **usa llaves nuevas** en el servidor.
- `MemoryMax=3G` en el servicio: si un video muy pesado se pasa, systemd reinicia Gancho y el trabajo se retoma solo.
