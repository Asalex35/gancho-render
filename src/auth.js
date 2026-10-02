// Usuarios en Postgres, contraseñas con scrypt, sesión en cookie firmada (sirve con varias instancias).
import crypto from "node:crypto";
import { one, q } from "./db.js";
import { config } from "./config.js";

const COOKIE = "gancho_sesion";
const DURACION_MS = 12 * 3600e3;

export function hashClave(clave) {
  const sal = crypto.randomBytes(16);
  const h = crypto.scryptSync(String(clave), sal, 32);
  return `scrypt$${sal.toString("base64")}$${h.toString("base64")}`;
}
function claveOk(clave, guardado) {
  const [, sal, h] = String(guardado || "").split("$");
  if (!sal || !h) return false;
  const real = crypto.scryptSync(String(clave), Buffer.from(sal, "base64"), 32);
  return crypto.timingSafeEqual(real, Buffer.from(h, "base64"));
}
const HASH_FALSO = hashClave(crypto.randomBytes(8).toString("hex"));

export const validarClave = (c) => (String(c || "").length >= 10 ? null : "La contraseña debe tener al menos 10 caracteres.");
export const normalizarUsuario = (u) => String(u || "").trim().toLowerCase();

// Crea el admin inicial y migra los usuarios de APP_USERS (versión anterior).
export async function sembrarUsuarios() {
  const pares = config.legacyUsers.split(",").map((p) => p.trim()).filter(Boolean).map((p) => [p.slice(0, p.indexOf(":")), p.slice(p.indexOf(":") + 1)]);
  if (config.admin.user && config.admin.password) pares.unshift([config.admin.user, config.admin.password, "admin"]);
  const hay = await one("SELECT count(*)::int AS n FROM usuarios");
  for (const [i, [u, c, rol]] of pares.entries()) {
    const usuario = normalizarUsuario(u);
    if (!usuario || !c) continue;
    // El primer usuario de todos es admin.
    await q("INSERT INTO usuarios (usuario, clave_hash, rol) VALUES ($1, $2, $3) ON CONFLICT (usuario) DO NOTHING",
      [usuario, hashClave(c), rol || (hay.n === 0 && i === 0 ? "admin" : "editor")]);
  }
}

export async function verificar(usuario, clave) {
  const u = await one("SELECT * FROM usuarios WHERE usuario = $1 AND activo", [normalizarUsuario(usuario)]);
  const ok = claveOk(clave || "", u?.clave_hash || HASH_FALSO);
  return u && ok ? u : null;
}

const firmar = (data) => crypto.createHmac("sha256", config.sessionSecret).update(data).digest("base64url");

export function crearSesion(res, u) {
  // "h" atado al hash de la contraseña: cambiar la contraseña cierra las sesiones viejas.
  const data = Buffer.from(JSON.stringify({ id: u.id, h: u.clave_hash.slice(-12), exp: Date.now() + DURACION_MS })).toString("base64url");
  res.cookie(COOKIE, `${data}.${firmar(data)}`, { httpOnly: true, secure: config.prod, sameSite: "lax", maxAge: DURACION_MS, path: "/" });
}
export const cerrarSesion = (res) => res.clearCookie(COOKIE, { path: "/" });

// Pequeño caché para no consultar la base en cada petición.
const cache = new Map();
async function usuarioPorId(id) {
  const c = cache.get(id);
  if (c && c.t > Date.now() - 30e3) return c.u;
  const u = await one("SELECT id, usuario, rol, activo, clave_hash FROM usuarios WHERE id = $1", [id]);
  cache.set(id, { u, t: Date.now() });
  return u;
}
export const olvidarUsuario = (id) => cache.delete(id);

export async function usuarioDe(req) {
  const raw = (req.headers.cookie || "").split(";").map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`));
  if (!raw) return null;
  let data, firma;
  try { [data, firma] = decodeURIComponent(raw.slice(COOKIE.length + 1)).split("."); } catch { return null; }
  if (!data || !firma) return null;
  const esperada = firmar(data);
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const s = JSON.parse(Buffer.from(data, "base64url").toString());
    if (Date.now() > s.exp) return null;
    const u = await usuarioPorId(s.id);
    if (!u?.activo || u.clave_hash.slice(-12) !== s.h) return null;
    return { id: u.id, usuario: u.usuario, rol: u.rol };
  } catch { return null; }
}

export function requiereSesion(req, res, next) {
  usuarioDe(req).then((u) => {
    if (!u) {
      if (req.path.startsWith("/api/") || req.path.startsWith("/media/")) return res.status(401).json({ error: "Tu sesión expiró. Vuelve a entrar." });
      return res.redirect("/login");
    }
    req.user = u;
    req.usuario = u.usuario;
    next();
  }).catch(next);
}

export function soloAdmin(req, res, next) {
  if (req.user?.rol !== "admin") return res.status(403).json({ error: "Solo un administrador puede hacer esto." });
  next();
}

// CSRF: las peticiones que cambian datos deben traer este encabezado, que otro sitio no puede mandar.
export function antiCsrf(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  if (req.get("X-Gancho") !== "1") return res.status(403).json({ error: "Petición rechazada." });
  next();
}
