// What the page reads. Two sources, merged:
//   - the stored card, pushed in by the collector running in your browser
//   - the two feeds a server can still reach by itself, so the site is never
//     empty even before anything has been collected.

import { sql, rowToGame, cors } from "./_db.js";
import { store } from "./_store.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MARKET_IDS = "1,10,60";
const WANTED = { "1X2": "ft", "Double Chance": "dc", "1st Half - 1X2": "ht" };

// Only these two honour sportId. The rest return real football whatever you
// ask for, which is why every event is checked against SPORT below.
const FEEDS = [
  ["wapConfigurableUpcomingEvents", {}],
  ["configurableLiveOrPrematchEvents",
    { tournamentId: "sv:league:1", marketId: MARKET_IDS, pageSize: "100", pageNum: "1" }],
];

async function feed([path, params]) {
  const q = new URLSearchParams({ sportId: SPORT, ...params });
  const r = await fetch(`${BASE}/${path}?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) return [];
  const body = await r.json();
  return body.bizCode === 10000 ? collect(body.data) : [];
}

function collect(node, found = []) {
  if (Array.isArray(node)) { for (const n of node) collect(n, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (node.gameId && node.homeTeamName) found.push(node);
  for (const v of Object.values(node)) collect(v, found);
  return found;
}

function legs(market) {
  const by = {};
  for (const o of market.outcomes || []) {
    const p = parseFloat(o.odds);
    if (isFinite(p)) by[o.desc] = p;
  }
  return by;
}

function normalise(ev) {
  if ((ev.sport || {}).id !== SPORT) return null;
  const got = {};
  for (const m of ev.markets || []) {
    const slot = WANTED[m.desc];
    if (slot && !got[slot]) got[slot] = legs(m);
  }
  const ft = got.ft;
  if (!ft || ft.Home == null || ft.Draw == null || ft.Away == null) return null;
  const dc = got.dc, ht = got.ht;
  return {
    id: String(ev.gameId),
    home: ev.homeTeamName || "?",
    away: ev.awayTeamName || "?",
    league: ev.tournamentName || ev.categoryName || "",
    kickoff: ev.estimateStartTime || null,
    status: ev.matchStatus || "",
    upcoming: ev.matchStatus === "Not start",
    ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
    dc: dc && dc["Home or Draw"] != null
      ? { home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"] }
      : null,
    ht: ht && ht.Home != null ? { home: ht.Home, draw: ht.Draw, away: ht.Away } : null,
  };
}

/** A live reading is fresher than a stored one, so it wins on the odds. */
function merge(into, game, live) {
  const prev = into.get(game.id);
  if (!prev) { into.set(game.id, game); return; }
  if (live) {
    prev.ft = game.ft; prev.status = game.status; prev.upcoming = game.upcoming;
  }
  prev.dc = live ? (game.dc || prev.dc) : (prev.dc || game.dc);
  prev.ht = live ? (game.ht || prev.ht) : (prev.ht || game.ht);
  prev.league = prev.league || game.league;
  prev.kickoff = prev.kickoff || game.kickoff;
}

export default async function handler(req, res) {
  cors(res);
  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const includeLive = url.searchParams.get("live") === "1";

  const [stored, ...feeds] = await Promise.allSettled([
    sql`SELECT * FROM games ORDER BY kickoff DESC NULLS LAST LIMIT 2000`,
    ...FEEDS.map(feed),
  ]);

  const byId = new Map();
  if (stored.status === "fulfilled") {
    for (const row of stored.value) merge(byId, rowToGame(row), false);
  }
  const fresh = [];
  for (const f of feeds) {
    if (f.status !== "fulfilled") continue;
    for (const ev of f.value) {
      const g = normalise(ev);
      if (g) { merge(byId, g, true); fresh.push(g); }
    }
  }
  const live = fresh.length;

  // Only games that have not kicked off can still be backed, so the view is
  // upcoming-only unless asked otherwise. Live games are still recorded.
  let games = [...byId.values()];
  if (!includeLive) games = games.filter((g) => g.upcoming);
  games.sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));

  // Every read also records what the feeds showed, so the card builds up a
  // history on its own. Nothing has to be installed anywhere for this.
  // A write must never fail a read, but it must never fail silently either:
  // swallowing this is what hid sql.query not existing on the driver.
  let saved = 0, saveError = null;
  try { saved = await store(fresh); }
  catch (e) { saveError = String(e?.message || e); }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    fetchedAt: Date.now(),
    tookMs: Date.now() - started,
    storedInDb: stored.status === "fulfilled" ? stored.value.length : 0,
    fromLiveFeeds: live,
    savedThisVisit: saved,
    saveError,
    dbError: stored.status === "rejected" ? String(stored.reason?.message || stored.reason) : null,
    count: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    liveSeen: fresh.filter((g) => !g.upcoming).length,
    screenable: games.filter((g) => g.upcoming && g.dc && g.ht).length,
    games,
  });
}
