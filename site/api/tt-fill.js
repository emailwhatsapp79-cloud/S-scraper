// Dedicated TT ingestion. Runs in the page's background loop and off the daily
// poll — never on the critical card-load path. Each pass: refresh SportyBet's
// card + a batch of its per-event odds/results, then bank a chunk of scores24
// history. Bounded so the whole thing stays under the 30s function limit.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, enrichSettleTT, countsTT, rebuildPack } from "./_tt.js";
import { pullScores24 } from "./_s24.js";
import { pullSetka } from "./_setka.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  if (String(req.query?.pack || "") === "1") {
    let pack = null;
    try { pack = await rebuildPack(); } catch (e) { pack = { error: String(e?.message || e) }; }
    let counts = { total: 0, settled: 0 };
    try { counts = await countsTT(); } catch { /* ignore */ }
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      ok: !pack?.error,
      tookMs: Date.now() - started,
      pack, hasMore: false,
      stored: counts.total, settled: counts.settled,
    });
  }
  const wantCard = String(req.query?.card || "") === "1";
  let card = 0, enriched = 0, cardErr = null, setka = null;

  if (wantCard) {
    let setkaNames = [];
    try {
      const { events } = await fetchTTCard();
      const games = events.map(normalise);
      card = await storeTT(games);
      // Only Setka-Cup players live in the Setka feed; skip the rest.
      setkaNames = games.filter((g) => /setka/i.test(g.tourn || ""))
        .flatMap((g) => [g.home, g.away]).filter(Boolean);
    } catch (e) { cardErr = String(e?.message || e); }
    try { enriched = (await enrichSettleTT(12)).touched; } catch { /* keep going */ }
    // Official Setka feed — fills history for the pools scores24 doesn't carry.
    try { setka = await pullSetka(setkaNames, { players: 5, tournaments: 6, deadlineMs: 9000 }); }
    catch (e) { setka = { error: String(e?.message || e) }; }
  }

  // s24 runs on the alternating (non-card) passes; the card pass does card +
  // enrich + Setka, so neither pass crowds the 30s budget.
  let s24 = null;
  if (!wantCard) {
    const budget = Math.max(6000, 24000 - (Date.now() - started));
    try {
      s24 = await pullScores24([], {
        skipHtml: true, more: true, pages: 4, first: 50, days: 400,
        players: 0, deadlineMs: budget,
      });
    } catch (e) { s24 = { error: String(e?.message || e), hasMore: true }; }
  }

  let counts = { total: 0, settled: 0 };
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !s24?.error,
    tookMs: Date.now() - started,
    card, enriched, cardErr, setka,
    s24,
    // Keep the page's fast loop going while either source still has more to bank.
    hasMore: !!(s24 && (s24.hasMore || s24.error)) || !!(setka && setka.saved > 0),
    stored: counts.total,
    settled: counts.settled,
  });
}
