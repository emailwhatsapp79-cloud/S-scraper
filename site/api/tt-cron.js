// Background TT history. No PIN — Vercel cron hits this with the site closed.
import { cors } from "./_db.js";
import { countsTT } from "./_tt.js";
import { pullScores24 } from "./_s24.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const started = Date.now();
  let s24 = null;
  try {
    s24 = await pullScores24([], {
      skipHtml: true, more: true, pages: 5, first: 50, days: 60, players: 0,
    });
  } catch (e) {
    s24 = { error: String(e?.message || e) };
  }
  let counts = { total: 0, settled: 0 };
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !s24?.error,
    tookMs: Date.now() - started,
    s24,
    stored: counts.total,
    settled: counts.settled,
    hasMore: !!(s24 && s24.hasMore),
  });
}
