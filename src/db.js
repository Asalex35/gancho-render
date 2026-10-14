import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { config, sslDe } from "./config.js";

const ssl = sslDe();
export const pool = new pg.Pool({
  connectionString: config.databaseUrl, ssl, max: Number(process.env.DB_POOL || 10),
  statement_timeout: 60000, connectionTimeoutMillis: 10000,
});
pool.on("error", (e) => console.error("Postgres:", e.message));

export const q = (sql, params) => pool.query(sql, params);
export const one = async (sql, params) => (await pool.query(sql, params)).rows[0] || null;
export const all = async (sql, params) => (await pool.query(sql, params)).rows;

export async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    const r = await fn(c);
    await c.query("COMMIT");
    return r;
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Solo aplica el esquema si cambió (los ALTER bloquean tablas aunque no hagan nada).
export async function migrar() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = await fs.readFile(path.join(dir, "schema.sql"), "utf8");
  const hash = crypto.createHash("sha256").update(sql).digest("hex");
  await pool.query("CREATE TABLE IF NOT EXISTS gancho_meta (k text PRIMARY KEY, v text NOT NULL)");
  const actual = await one("SELECT v FROM gancho_meta WHERE k = 'schema'");
  if (actual?.v === hash) return;
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(424242)"); // dos instancias no migran a la vez
    await c.query("SET LOCAL lock_timeout = '10s'");
    await c.query("SET LOCAL statement_timeout = 0"); // crear índices en tablas grandes puede tardar
    await c.query(sql);
    await c.query("INSERT INTO gancho_meta (k, v) VALUES ('schema', $1) ON CONFLICT (k) DO UPDATE SET v = $1", [hash]);
  });
  console.log("Esquema de base de datos actualizado.");
}
