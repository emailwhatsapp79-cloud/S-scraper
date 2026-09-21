// Table-tennis card — serve only. Reads the banked pile from the DB (upcoming
// games with our ratings, recent results, the model self-check) and returns it
// fast. All the slow ingestion — pulling SportyBet's card and its per-event odds
// — lives in /api/tt-fill (the page's background loop) and the daily poll, so a
// card load never waits on SportyBet's servers. Gated like the rest of the app.
import { guard } from "./_gate.js";
import { listUpcomingTT, listRecentResultsTT, countsTT, getModelMeta } from "./_tt.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();

  let games = [], results = [], counts = { total: 0, settled: 0 }, model = null, error = null;
  try { games = await listUpcomingTT(400); } catch (e) { error = String(e?.message || e); }
  try { results = await listRecentResultsTT(60); } catch { /* ignore */ }
  try { counts = await countsTT(); } catch { /* ignore */ }
  try { model = await getModelMeta(); } catch { /* ignore */ }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    error,
    stored: counts.total,
    settled: counts.settled,
    count: games.length,
    games,
    results,
    model,
  });
}
