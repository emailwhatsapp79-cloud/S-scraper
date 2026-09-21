import { sql, logErr } from "./_db.js";

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS health (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  ready = true;
}

export async function touchHealth(k, data) {
  try {
    await ensure();
    const v = JSON.stringify(data || {});
    await sql`
      INSERT INTO health (k, v, at) VALUES (${k}, ${v}, now())
      ON CONFLICT (k) DO UPDATE SET v = ${v}, at = now()`;
  } catch (e) { logErr("health.touch " + k, e); }
}

export async function readHealth() {
  try {
    await ensure();
    const rows = await sql`SELECT k, v, at FROM health ORDER BY at DESC`;
    const out = {};
    for (const r of rows) {
      let data = {};
      try { data = JSON.parse(r.v); } catch { data = {}; }
      out[r.k] = { ...data, at: r.at };
    }
    return out;
  } catch (e) {
    logErr("health.read", e);
    return {};
  }
}
