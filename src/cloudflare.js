// Cloudflare Access (servidores del ERP): Cloudflare pide el correo @prismaticoos.com antes de llegar a Gancho y manda
// un JWT firmado en el encabezado Cf-Access-Jwt-Assertion. Gancho lo verifica: si alguien llegara sin pasar por
// Cloudflare (otro camino al servidor), no entra. Se activa con CF_ACCESS_TEAM (el «team domain» de Zero Trust, sin
// .cloudflareaccess.com) y CF_ACCESS_AUD (Application Audience tag de la aplicación de Access de este hostname).
import crypto from "node:crypto";

const TEAM = process.env.CF_ACCESS_TEAM;
const AUD = process.env.CF_ACCESS_AUD;
export const accessActivo = Boolean(TEAM && AUD);
// Media configuración apagaría la protección sin avisar: mejor no arrancar.
if (Boolean(TEAM) !== Boolean(AUD)) throw new Error("Cloudflare Access: pon CF_ACCESS_TEAM y CF_ACCESS_AUD (las dos) o ninguna.");
const EMISOR = `https://${TEAM}.cloudflareaccess.com`;

let llaves = { leidas: 0, intento: 0, porKid: new Map() };
let enCurso = null; // una sola lectura a la vez, compartida por todas las peticiones
async function releer() {
  const r = await fetch(`${EMISOR}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000), redirect: "error" });
  if (!r.ok) throw new Error(`Cloudflare Access respondió ${r.status} al pedir sus llaves.`);
  const { keys = [] } = await r.json();
  const porKid = new Map(keys.filter((k) => k.kty === "RSA").map((k) => [k.kid, crypto.createPublicKey({ key: k, format: "jwk" })]));
  if (!porKid.size) throw new Error("Cloudflare Access no devolvió llaves.");
  llaves = { leidas: Date.now(), intento: Date.now(), porKid };
}
async function llave(kid) {
  // Cloudflare rota sus llaves: se releen cada hora o con un kid desconocido, como mucho un intento por minuto.
  // Si la relectura falla, se siguen usando las llaves que ya se tenían.
  const ahora = Date.now();
  const toca = ahora - llaves.leidas > 3600e3 || !llaves.porKid.has(kid);
  if (toca && ahora - llaves.intento > 60e3) {
    llaves.intento = ahora;
    enCurso ||= releer().finally(() => { enCurso = null; });
    try { await enCurso; } catch (e) { if (!llaves.porKid.has(kid)) throw e; console.warn("Cloudflare Access:", e.message, "(se usan las llaves anteriores)"); }
  } else if (enCurso) await enCurso.catch(() => {});
  return llaves.porKid.get(kid);
}

const json = (s) => JSON.parse(Buffer.from(s, "base64url").toString());
export async function verificarAccess(jwt) {
  const [h, p, s] = String(jwt || "").split(".");
  if (!h || !p || !s) throw new Error("Falta el pase de Cloudflare Access.");
  const cabeza = json(h);
  if (cabeza.alg !== "RS256") throw new Error("Pase de Cloudflare con algoritmo no permitido.");
  const k = await llave(cabeza.kid);
  if (!k || !crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`), k, Buffer.from(s, "base64url"))) throw new Error("Pase de Cloudflare no válido.");
  const c = json(p);
  const ahora = Date.now() / 1000;
  if (!(Array.isArray(c.aud) ? c.aud : [c.aud]).includes(AUD)) throw new Error("El pase de Cloudflare es de otra aplicación.");
  if (c.iss !== EMISOR) throw new Error("El pase de Cloudflare es de otra organización.");
  if (!(c.exp > ahora) || (c.nbf && c.nbf > ahora + 60)) throw new Error("El pase de Cloudflare venció. Recarga la página.");
  const email = String(c.email || "").trim().toLowerCase();
  if (!email) throw new Error("El pase de Cloudflare no trae correo.");
  return { email };
}

// Middleware: todo pide el pase menos lo que llama el propio servidor (salud) o un proveedor con liga firmada (/pub).
export function exigirAccess(libres = []) {
  return (req, res, next) => {
    if (!accessActivo || libres.some((r) => req.path === r || req.path.startsWith(`${r}/`))) return next();
    verificarAccess(req.get("cf-access-jwt-assertion")).then((a) => { req.access = a; next(); }, (e) => {
      console.warn("Cloudflare Access:", e.message);
      res.status(403).type("text/plain; charset=utf-8").send("Gancho solo se abre desde el ERP de Prismaticoos.");
    });
  };
}
