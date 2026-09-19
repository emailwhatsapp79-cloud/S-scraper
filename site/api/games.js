// Page reader. The card is five GETs — one per virtual league, option=2 —
// which is the remaining day, not the 10-game highlight window.
import { sql, rowToGame, cors } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, normalise } from "./_card.js";

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

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const includeLive = url.searchParams.get("live") === "1";

  const [stored, card] = await Promise.allSettled([
    sql`SELECT * FROM games ORDER BY kickoff DESC NULLS LAST LIMIT 2000`,
    fetchCard(),
  ]);

  const byId = new Map();
  if (stored.status === "fulfilled") {
    for (const row of stored.value) merge(byId, rowToGame(row), false);
  }

  const fresh = [];
  let feedErrors = [];
  if (card.status === "fulfilled") {
    feedErrors = card.value.errors || [];
    for (const ev of card.value.events) {
      const g = normalise(ev);
      if (g) { merge(byId, g, true); fresh.push(g); }
    }
  } else {
    feedErrors = [String(card.reason?.message || card.reason)];
  }

  let games = [...byId.values()];
  if (!includeLive) games = games.filter((g) => g.upcoming);
  games.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));

  let saved = 0, saveError = null;
  try { saved = await store(fresh); }
  catch (e) { saveError = String(e?.message || e); }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    fetchedAt: Date.now(),
    tookMs: Date.now() - started,
    storedInDb: stored.status === "fulfilled" ? stored.value.length : 0,
    fromLiveFeeds: fresh.length,
    savedThisVisit: saved,
    saveError,
    feedErrors: feedErrors.length ? feedErrors : null,
    dbError: stored.status === "rejected" ? String(stored.reason?.message || stored.reason) : null,
    count: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    liveSeen: fresh.filter((g) => !g.upcoming).length,
    screenable: games.filter((g) => g.upcoming && g.dc && g.ht).length,
    games,
  });
}
