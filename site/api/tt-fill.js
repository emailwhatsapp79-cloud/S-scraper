// Dedicated TT history fill. The main /api/tt card load was dying at 30s
// before scores24 could save. This path only banks finished games.
import { guard } from "./_gate.js";
import { countsTT } from "./_tt.js";
import { pullScores24 } from "./_s24.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  let s24 = null;
  try {
    s24 = await pullScores24([], {
      skipHtml: true, more: true, pages: 2, first: 50, days: 400,
      players: 0,
    });
  }
  catch (e) { s24 = { error: String(e?.message || e), hasMore: true }; }
  let counts = { total: 0, settled: 0 };
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !s24?.error,
    tookMs: Date.now() - started,
    s24,
    hasMore: !!(s24 && (s24.hasMore || s24.error)),
    stored: counts.total,
    settled: counts.settled,
  });
}
