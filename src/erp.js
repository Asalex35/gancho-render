// Modo ERP: Gancho como módulo del ERP de Prismaticoos (Social Media › Portadas).
// Todo se activa con variables de entorno; sin ellas Gancho funciona igual que siempre.
//
//  ERP_SSO_SECRET   llave compartida con el ERP para el inicio de sesión único (la pega Luis en ambos lados).
//  ERP_SOLO=1       el login con contraseña de Gancho se apaga (solo se entra desde el ERP); queda ADMIN_USER de emergencia.
//  ERP_DOMINIO      dominio de correo permitido (por defecto prismaticoos.com).
//  ERP_ORIGENES     orígenes que pueden mostrar Gancho dentro del ERP (iframe), separados por espacio.
//  ERP_BITACORA_URL + ERP_BITACORA_SECRET   a dónde se manda cada acción para la bitácora del ERP (firmado).
//  ERP_BITACORA_CF_ID + ERP_BITACORA_CF_SECRET   service token de Cloudflare Access para llegar al ERP.
//  ERP_LIMITE_USD   gasto máximo de IA que un no-administrador puede lanzar de una vez (regla del ERP: más de US$5 lo aprueba Luis).
import crypto from "node:crypto";
import { one, q } from "./db.js";
import { hashClave } from "./auth.js";
import { usdPorImagen } from "./ai/imagen.js";

const env = process.env;
export const erp = {
  activo: Boolean(env.ERP_SSO_SECRET),
  solo: env.ERP_SOLO === "1",
  dominio: (env.ERP_DOMINIO || "prismaticoos.com").toLowerCase(),
  // https en pruebas/producción; http solo para la red de la oficina (*.local, localhost) en desarrollo.
  origenes: String(env.ERP_ORIGENES || "").split(/\s+/).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o) || /^http:\/\/([a-z0-9-]+\.local|localhost)(:\d+)?$/i.test(o)),
  limiteUsd: env.ERP_LIMITE_USD ? Number(env.ERP_LIMITE_USD) : null,
};
// Costo aproximado en dólares (para avisar y para la regla de aprobación).
export const USD_POR_IMAGEN = usdPorImagen("pro");
export const USD_POR_EPISODIO_TEXTO = 0.3;

// El usuario de Gancho sale del correo del ERP (la parte antes de @, limpia). Misma regla en el token y en Access.
export const usuarioDeCorreo = (email) => String(email || "").trim().toLowerCase().split("@")[0].replace(/[^a-z0-9._-]/g, "").slice(0, 40);
const firmar = (datos) => crypto.createHmac("sha256", env.ERP_SSO_SECRET).update(datos).digest("base64url");
const usados = new Map(); // tokens ya usados (no se pueden reusar) → vencimiento

// Token que genera el ERP: base64url(JSON {email, nombre, rol, exp, n}) + "." + HMAC-SHA256(llave compartida).
// exp en segundos (máx. 2 min de vida), n = número único. rol: "admin" o "editor".
export async function entrarConToken(token, correoAccess) {
  if (!erp.activo) throw new Error("El inicio desde el ERP no está activado.");
  const [datos, firma] = String(token || "").split(".");
  if (!datos || !firma) throw new Error("Enlace no válido.");
  const a = Buffer.from(firma), b = Buffer.from(firmar(datos));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("Enlace no válido.");
  let t;
  try { t = JSON.parse(Buffer.from(datos, "base64url").toString()); } catch { throw new Error("Enlace no válido."); }
  const ahora = Date.now() / 1000;
  if (!(t.exp > ahora) || t.exp - ahora > 120) throw new Error("El enlace ya venció. Vuelve a entrar desde el ERP.");
  const clave = `${t.n}|${t.exp}`;
  for (const [k, v] of usados) if (v < ahora) usados.delete(k);
  if (!t.n || usados.has(clave)) throw new Error("Ese enlace ya se usó. Vuelve a entrar desde el ERP.");
  usados.set(clave, t.exp);
  const email = String(t.email || "").trim().toLowerCase();
  if (!email.endsWith(`@${erp.dominio}`)) throw new Error(`Solo cuentas @${erp.dominio}.`);
  if (correoAccess && correoAccess !== email) throw new Error("La cuenta con la que entraste a Cloudflare no es la misma del ERP. Cierra sesión y vuelve a entrar.");
  const usuario = usuarioDeCorreo(email);
  if (usuario.length < 2) throw new Error("Correo no válido.");
  const rol = t.rol === "admin" ? "admin" : "editor";
  // El ERP manda: alta automática y el rol se actualiza en cada entrada. La contraseña local queda inservible.
  const u = await one(`INSERT INTO usuarios (usuario, clave_hash, rol) VALUES ($1, $2, $3)
      ON CONFLICT (usuario) DO UPDATE SET rol = excluded.rol RETURNING *`,
    [usuario, hashClave(crypto.randomBytes(24).toString("hex")), rol]);
  if (!u.activo) throw new Error("Tu usuario está desactivado en Gancho.");
  return u;
}

// Bitácora: quién hizo qué y cuándo. Se guarda en Gancho y, si está configurado, se manda al ERP (firmado).
export async function registrar(req, accion, detalle = {}) {
  const usuario = req?.usuario || "sistema";
  const evento = { usuario, email: req?.access?.email || (usuario === "sistema" ? null : `${usuario}@${erp.dominio}`), accion, detalle, ip: req?.ip || null, cuando: new Date().toISOString() };
  await q("INSERT INTO bitacora (usuario, accion, detalle, ip) VALUES ($1,$2,$3,$4)", [usuario, accion, detalle, evento.ip]).catch((e) => console.warn("Bitácora:", e.message));
  if (!env.ERP_BITACORA_URL || !env.ERP_BITACORA_SECRET) return;
  const cuerpo = JSON.stringify({ modulo: "gancho", ...evento });
  const sello = crypto.createHmac("sha256", env.ERP_BITACORA_SECRET).update(cuerpo).digest("hex");
  // El ERP rechaza un POST cuyo Origin no sea el suyo (anti-CSRF) y está detrás de Cloudflare Access: Gancho se
  // identifica con un service token de Access (ERP_BITACORA_CF_ID / ERP_BITACORA_CF_SECRET).
  const cabeceras = { "Content-Type": "application/json", "X-Gancho-Firma": sello, Origin: new URL(env.ERP_BITACORA_URL).origin };
  if (env.ERP_BITACORA_CF_ID && env.ERP_BITACORA_CF_SECRET) Object.assign(cabeceras, { "CF-Access-Client-Id": env.ERP_BITACORA_CF_ID, "CF-Access-Client-Secret": env.ERP_BITACORA_CF_SECRET });
  fetch(env.ERP_BITACORA_URL, { method: "POST", headers: cabeceras, body: cuerpo,
    signal: AbortSignal.timeout(8000), redirect: "error" }).catch((e) => console.warn("Bitácora ERP:", e.message));
}

// Regla del ERP: un trabajo de IA de más de US$X lo debe lanzar un administrador.
export function revisarGasto(req, usd) {
  if (erp.limiteUsd == null || req.user?.rol === "admin" || usd <= erp.limiteUsd) return;
  throw Object.assign(new Error(`Esto cuesta ≈ US$${usd.toFixed(2)} y pasa del límite de US$${erp.limiteUsd}. Pídele a un administrador que lo lance.`), { publico: true, status: 403 });
}
