// Table-tennis card. Grabs SportyBet's upcoming card (fast — one page, ~1.7s) so
// every game shows the instant the page loads, then serves the banked pile from
// the DB with our ratings attached. The slow part — per-event odds/score enrich
// and scores24 history — stays in /api/tt-fill (the page's background loop) and
// the daily poll, so the card never waits on that. Gated like the rest.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, listUpcomingTT, listRecentResultsTT, countsTT, getModelMeta } from "./_tt.js";
import { fetchTennisCard, enrichTennis, trackTennis, trackBooks, bookedTennisRecord } from "./_tennis.js";

function queryOf(req) {
  if (req.query) return req.query;
  const raw = String(req.url || "");
  const i = raw.indexOf("?");
  return new URLSearchParams(i < 0 ? "" : raw.slice(i + 1));
}

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  const q = queryOf(req);
  if (String(q.card || "") === "tennis" && String(q.record || "") === "1") {
    try {
      const [booked, books] = await Promise.all([
        bookedTennisRecord(),
        trackBooks([], { settle: true }),
      ]);
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, booked, books });
    } catch (e) {
      res.status(200).json({ ok: false, error: String(e?.message || e), booked: null });
    }
    return;
  }
  if (String(q.card || "") === "tennis") {
    try {
      const games = await fetchTennisCard();
      let record = null;
      if (String(q.fresh || "") !== "1") {
        try { await enrichTennis(games); } catch { /* book prices still stand */ }
        try { await trackTennis(games); } catch { /* ahead history stays cleared */ }
      }
      try { await trackBooks(games, { settle: false }); } catch { /* the card still loads */ }
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: true, tookMs: Date.now() - started, count: games.length, games, record });
    } catch (e) {
      res.status(200).json({ ok: false, error: String(e?.message || e), games: [] });
    }
    return;
  }

  // Fresh card first, so the available games are never stale on load. Failures
  // here (SportyBet slow/down) never block the serve — we fall back to the DB.
  let cardErr = null;
  try {
    const { events } = await fetchTTCard();
    await storeTT(events.map(normalise));
  } catch (e) { cardErr = String(e?.message || e); }

  let games = [], results = [], counts = { total: 0, settled: 0 }, model = null, error = null;
  try { games = await listUpcomingTT(400); } catch (e) { error = String(e?.message || e); }
  try { results = await listRecentResultsTT(60); } catch { /* ignore */ }
  try { counts = await countsTT(); } catch { /* ignore */ }
  try { model = await getModelMeta(); } catch { /* ignore */ }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    error, cardErr,
    stored: counts.total,
    settled: counts.settled,
    count: games.length,
    games,
    results,
    model,
  });
}
