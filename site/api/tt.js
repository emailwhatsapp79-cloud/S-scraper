// Table-tennis card. Grabs SportyBet's upcoming card (fast — one page, ~1.7s) so
// every game shows the instant the page loads, then serves the banked pile from
// the DB with our ratings attached. The slow part — per-event odds/score enrich
// and scores24 history — stays in /api/tt-fill (the page's background loop) and
// the daily poll, so the card never waits on that. Gated like the rest.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, listUpcomingTT, listRecentResultsTT, countsTT, getModelMeta } from "./_tt.js";
import { refreshEB, listEB, recordEB, countsEB } from "./_eb.js";
import { fetchTennisCard, enrichTennis, trackTennis, trackBooks, bookedTennisRecord, backfillBooks } from "./_tennis.js";

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
  // eBasketball, paper only. Rides this function rather than its own so the
  // deployment does not grow another serverless function.
  if (String(q.card || "") === "eb" && String(q.bank || "") === "1") {
    let pass;
    try { pass = await refreshEB(); } catch (e) { pass = { error: String(e?.message || e) }; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: !pass.error, tookMs: Date.now() - started, pass });
    return;
  }
  if (String(q.card || "") === "eb") {
    let pass = null, record = null, games = [], counts = null, error = null;
    try { pass = await refreshEB(); } catch (e) { pass = { error: String(e?.message || e) }; }
    try { record = await recordEB(); } catch (e) { error = String(e?.message || e); }
    try { games = await listEB(!!(record && record.proven)); } catch (e) { error = error || String(e?.message || e); }
    try { counts = await countsEB(); } catch { /* the card still shows */ }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: !error, error, tookMs: Date.now() - started, pass, record, counts, games });
    return;
  }
  if (String(q.card || "") === "tennis" && String(q.record || "") === "1") {
    try {
      try { await backfillBooks(); } catch { /* the saved rows still show */ }
      const [booked, books] = await Promise.all([
        bookedTennisRecord(),
        trackBooks([], { settle: false }),
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
      // Tags come from player stats now. The old enrichment (scores24 form, which
      // Vercel can't reach, plus two tip sites) cost up to ~20s a load, so it only
      // runs when asked for (?enrich=1).
      if (String(q.enrich || "") === "1") {
        try { await enrichTennis(games); } catch { /* book prices still stand */ }
        try { await trackTennis(games); } catch { /* ahead history stays cleared */ }
      }
      // Stats-only win chance per player pair (tn_ratings), the source of the tags.
      try { const { forecastTennis } = await import("./_tn_model.js"); await forecastTennis(games); }
      catch { /* the card still loads without stats */ }
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
  let cardErr = null, live = null;
  try {
    const { events } = await fetchTTCard();
    const fresh = events.map(normalise);
    await storeTT(fresh);
    live = new Map(fresh.map((g) => [g.id, g.open]));
  } catch (e) { cardErr = String(e?.message || e); }

  let games = [], results = [], counts = { total: 0, settled: 0 }, model = null, error = null;
  try { games = await listUpcomingTT(400); } catch (e) { error = String(e?.message || e); }
  // Watch-list players and poor records as big favourite: a warning, not a tag.
  try { const { annotateWatch } = await import("./_tt_watch.js"); await annotateWatch(games); } catch { /* the card still shows */ }
  // What SportyBet shows right now: a game whose winner market is suspended,
  // or that has dropped off its list, cannot be booked — say so on the card.
  if (live && live.size) {
    for (const g of games) {
      if (!live.has(g.id)) g.held = "Not on SportyBet now";
      else if (live.get(g.id) === false) g.held = "Suspended";
    }
  }
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
