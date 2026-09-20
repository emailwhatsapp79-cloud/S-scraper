// Page reader. Hits SportyBet at most once every couple of minutes;
// otherwise the stored remaining-day card is returned immediately.
import { sql, rowToGame } from "./_db.js";
import { store } from "./_store.js";
import { recordPicks } from "./_screen.js";
import { fetchCard, normalise } from "./_card.js";
import { guard } from "./_gate.js";
import { isUpcoming, leagueBucket, dropClashes } from "./_shape.js";

const CACHE_MS = 120000;

function keyOf(g) {
  return g.eventId || g.id;
}

function merge(into, game, live) {
  const key = keyOf(game);
  const prev = into.get(key) || into.get(game.id);
  if (!prev) {
    const copy = { ...game };
    if (live) copy.lastSeen = copy.lastSeen || new Date().toISOString();
    into.set(key, copy);
    return;
  }
  if (live) {
    prev.home = game.home || prev.home;
    prev.away = game.away || prev.away;
    prev.ft = game.ft;
    prev.status = game.status;
    prev.eventId = game.eventId || prev.eventId;
    prev.id = game.id || prev.id;
    if (game.kickoff) prev.kickoff = game.kickoff;
    prev.upcoming = isUpcoming(game.status, prev.kickoff);
    prev.lastSeen = new Date().toISOString();
  }
  prev.dc = live ? (game.dc || prev.dc) : (prev.dc || game.dc);
  prev.ht = live ? (game.ht || prev.ht) : (prev.ht || game.ht);
  prev.league = game.league || prev.league;
}

function seenMs(row) {
  if (!row?.last_seen && !row?.lastSeen) return 0;
  const t = new Date(row.last_seen || row.lastSeen).getTime();
  return isFinite(t) ? t : 0;
}

export default async function handler(req, res) {
  if (guard(req, res)) return;

  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const includeLive = url.searchParams.get("live") === "1";
  const force = url.searchParams.get("force") === "1";
  const cutoff = Date.now() - 2 * 60 * 1000;
  const seenSince = new Date(Date.now() - 15 * 60 * 1000).toISOString();

  let storedRows = [];
  let dbError = null;
  try {
    storedRows = await sql`
      SELECT * FROM games
      WHERE (kickoff IS NULL OR kickoff > ${cutoff})
        AND last_seen > ${seenSince}
      ORDER BY kickoff ASC NULLS LAST
      LIMIT 800`;
  } catch (e) {
    dbError = String(e?.message || e);
    try {
      storedRows = await sql`
        SELECT * FROM games
        WHERE kickoff IS NULL OR kickoff > ${cutoff}
        ORDER BY kickoff ASC NULLS LAST
        LIMIT 800`;
    } catch (e2) {
      dbError = String(e2?.message || e2);
    }
  }

  const newest = storedRows.reduce((t, r) => Math.max(t, seenMs(r)), 0);
  const age = newest ? Date.now() - newest : Infinity;
  const cached = !force && storedRows.length > 0 && age < CACHE_MS;

  const byId = new Map();
  const fresh = [];
  let feedErrors = [];

  if (cached) {
    for (const row of storedRows) merge(byId, rowToGame(row), false);
  } else {
    const card = await Promise.allSettled([fetchCard()]).then((r) => r[0]);
    if (card.status === "fulfilled") {
      feedErrors = card.value.errors || [];
      for (const ev of card.value.events) {
        const g = normalise(ev);
        if (g) { merge(byId, g, true); fresh.push(g); }
      }
    } else {
      feedErrors = [String(card.reason?.message || card.reason)];
    }
    if (!fresh.length) {
      for (const row of storedRows) merge(byId, rowToGame(row), false);
    } else {
      const have = new Set(fresh.map(leagueBucket));
      for (const row of storedRows) {
        const g = rowToGame(row);
        if (!have.has(leagueBucket(g))) merge(byId, g, false);
      }
    }
  }

  let games = dropClashes([...byId.values()]);
  if (!includeLive) games = games.filter((g) => g.upcoming);
  games.sort((a, b) => (Number(a.kickoff) || Infinity) - (Number(b.kickoff) || Infinity));

  let saved = 0, saveError = null;
  if (fresh.length) {
    try { saved = await store(fresh); }
    catch (e) { saveError = String(e?.message || e); }
  }

  try { await recordPicks(games); } catch { /* never fail a read over a pick */ }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    cached,
    cacheAgeMs: Number.isFinite(age) ? age : null,
    fetchedAt: Date.now(),
    tookMs: Date.now() - started,
    storedInDb: storedRows.length,
    fromLiveFeeds: fresh.length,
    savedThisVisit: saved,
    saveError,
    feedErrors: feedErrors.length ? feedErrors : null,
    dbError,
    count: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    liveSeen: fresh.filter((g) => !g.upcoming).length,
    screenable: games.filter((g) => g.upcoming && g.dc && g.ht).length,
    games,
  });
}
