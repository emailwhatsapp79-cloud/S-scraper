// Dedicated TT ingestion. Runs in the page's background loop and off the daily
// poll — never on the critical card-load path. Each pass: refresh SportyBet's
// card + a batch of its per-event odds/results, then bank a chunk of scores24
// history. Bounded so the whole thing stays under the 30s function limit.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, enrichSettleTT, countsTT } from "./_tt.js";
import { pullScores24 } from "./_s24.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  const wantCard = String(req.query?.card || "") === "1";
  let card = 0, enriched = 0, cardErr = null;

  if (wantCard) {
    try {
      const { events } = await fetchTTCard();
      card = await storeTT(events.map(normalise));
    } catch (e) { cardErr = String(e?.message || e); }
    try { enriched = (await enrichSettleTT(12)).touched; } catch { /* keep going */ }
  }

  let s24 = null;
  const budget = Math.max(6000, (wantCard ? 14000 : 24000) - (Date.now() - started));
  try {
    s24 = await pullScores24([], {
      skipHtml: true, more: true, pages: wantCard ? 2 : 4, first: 50, days: 400,
      players: 0, deadlineMs: budget,
    });
  } catch (e) { s24 = { error: String(e?.message || e), hasMore: true }; }

  let counts = { total: 0, settled: 0 };
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !s24?.error,
    tookMs: Date.now() - started,
    card, enriched, cardErr,
    s24,
    hasMore: !!(s24 && (s24.hasMore || s24.error)),
    stored: counts.total,
    settled: counts.settled,
  });
}
