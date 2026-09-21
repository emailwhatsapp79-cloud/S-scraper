// One-shot history bank. Same ON CONFLICT as the live fill: existing
// match_id is not duplicated. Keyed like s24-proxy so this can run
// from a dump without the PIN cookie.
import { cors } from "./_db.js";
import { bulkInsert } from "./_s24.js";
import { countsTT, rebuildPack } from "./_tt.js";

const KEY = process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if ((req.headers["x-fill-key"] || "") !== KEY) {
    return res.status(401).json({ ok: false, error: "no" });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const clean = [];
  const seen = new Set();
  for (const r of rows) {
    const id = String(r.id || "");
    if (!id.startsWith("s24:") && !id.startsWith("sofa:")) continue;
    if (seen.has(id)) continue;
    const home = String(r.home || "").trim();
    const away = String(r.away || "").trim();
    const rh = Number(r.r_home), ra = Number(r.r_away);
    if (!home || !away || !Number.isFinite(rh) || !Number.isFinite(ra)) continue;
    if (Math.max(rh, ra) < 3) continue;
    seen.add(id);
    clean.push({
      id,
      home, away,
      tourn: String(r.tourn || "").slice(0, 120),
      start: Number.isFinite(Number(r.start)) ? Number(r.start) : null,
      r_home: rh,
      r_away: ra,
    });
  }
  const cap = clean.slice(0, 400);
  const saved = cap.length ? await bulkInsert(cap) : 0;
  let pack = null;
  if (body.pack && saved) {
    try { pack = await rebuildPack(); } catch (e) { pack = { error: String(e?.message || e) }; }
  }
  let counts = { total: 0, settled: 0 };
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    took: cap.length,
    saved,
    stored: counts.total,
    settled: counts.settled,
    pack: pack ? { nGames: pack.nGames, builtAt: pack.builtAt, error: pack.error || null } : null,
  });
}
