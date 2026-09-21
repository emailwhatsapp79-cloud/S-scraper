// Night tick: booked slips + a TT history chunk so the pile grows with the
// tab closed. POST with x-fill-key banks a dump of finished games
// (ON CONFLICT match_id — already-there rows are not duplicated).
import { cors } from "./_db.js";
import { refreshSlips } from "./_slips.js";
import { pullScores24, bulkInsert } from "./_s24.js";
import { countsTT, rebuildPack } from "./_tt.js";

const KEY = process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  if (req.method === "POST" && (req.headers["x-fill-key"] || "") === KEY) {
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
        id, home, away,
        tourn: String(r.tourn || "").slice(0, 120),
        start: Number.isFinite(Number(r.start)) ? Number(r.start) : null,
        r_home: rh, r_away: ra,
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
      ok: true, took: cap.length, saved,
      stored: counts.total, settled: counts.settled,
      pack: pack ? { nGames: pack.nGames, builtAt: pack.builtAt, error: pack.error || null } : null,
    });
  }

  const started = Date.now();
  let slips = null;
  try { slips = await refreshSlips(); }
  catch (e) { slips = { error: String(e?.message || e) }; }
  let s24 = null, counts = { total: 0, settled: 0 };
  try {
    s24 = await pullScores24([], {
      skipHtml: true, more: true, pages: 5, first: 50, days: 400,
      players: 0, deadlineMs: 20000,
    });
  } catch (e) { s24 = { error: String(e?.message || e) }; }
  try { counts = await countsTT(); } catch { /* ignore */ }
  let pack = null;
  try { pack = await rebuildPack(); } catch (e) { pack = { error: String(e?.message || e) }; }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: !slips?.error,
    tookMs: Date.now() - started,
    slips, s24, pack,
    settled: counts.settled,
  });
}
