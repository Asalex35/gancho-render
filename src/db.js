import pg from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";

const ssl = /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false };
export const pool = new pg.Pool({ connectionString: config.databaseUrl, ssl, max: Number(process.env.DB_POOL || 10) });
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

export async function migrar() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = await fs.readFile(path.join(dir, "schema.sql"), "utf8");
  // Candado para que dos instancias no migren al mismo tiempo.
  await tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(424242)");
    await c.query(sql);
  });
}
