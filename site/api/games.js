// Page reader. Hits SportyBet at most once every couple of minutes;
// otherwise the stored remaining-day card is returned immediately.
import { sql, rowToGame } from "./_db.js";
import { store } from "./_store.js";
import { recordPicks } from "./_screen.js";
import { settleGames } from "./_results.js";
import { fetchCard, normalise } from "./_card.js";
import { guard } from "./_gate.js";

const CACHE_MS = 120000;

function merge(into, game, live) {
  const prev = into.get(game.id);
  if (!prev) { into.set(game.id, game); return; }
  if (live) {
    prev.ft = game.ft; prev.status = game.status; prev.upcoming = game.upcoming;
    prev.eventId = game.eventId || prev.eventId;
  }
  prev.dc = live ? (game.dc || prev.dc) : (prev.dc || game.dc);
  prev.ht = live ? (game.ht || prev.ht) : (prev.ht || game.ht);
  prev.league = game.league || prev.league;
  prev.kickoff = prev.kickoff || game.kickoff;
}

function seenMs(row) {
  if (!row?.last_seen) return 0;
  const t = new Date(row.last_seen).getTime();
  return isFinite(t) ? t : 0;
}

export default async function handler(req, res) {
  if (guard(req, res)) return;

  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const includeLive = url.searchParams.get("live") === "1";
  const force = url.searchParams.get("force") === "1";
  const cutoff = Date.now() - 2 * 60 * 1000;

  let storedRows = [];
  let dbError = null;
  try {
    storedRows = await sql`
      SELECT * FROM games
      WHERE kickoff IS NULL OR kickoff > ${cutoff}
      ORDER BY kickoff ASC NULLS LAST
      LIMIT 800`;
  } catch (e) {
    dbError = String(e?.message || e);
  }

  const newest = storedRows.reduce((t, r) => Math.max(t, seenMs(r)), 0);
  const age = newest ? Date.now() - newest : Infinity;
  const cached = !force && storedRows.length > 0 && age < CACHE_MS;

  const byId = new Map();
  for (const row of storedRows) merge(byId, rowToGame(row), false);

  const fresh = [];
  let feedErrors = [];
  if (!cached) {
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
  }

  let games = [...byId.values()];
  if (!includeLive) games = games.filter((g) => g.upcoming);
  games.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));

  let saved = 0, saveError = null;
  if (fresh.length) {
    try { saved = await store(fresh); }
    catch (e) { saveError = String(e?.message || e); }
  }

  try { await recordPicks(games); } catch (e) { /* never fail a read over a pick */ }

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
