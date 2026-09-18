// Reads the SportyBet vFootball card server-side and returns it normalised.
// The browser cannot call SportyBet directly: they send no CORS headers.

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

// Market 1 is 1X2, 10 is Double Chance, 60 is 1st Half - 1X2: the whole
// screen in one request, with no per-game detail call.
const MARKET_IDS = "1,10,60";
const WANTED = { "1X2": "ft", "Double Chance": "dc", "1st Half - 1X2": "ht" };

// Only two feeds actually honour sportId. The others -- configurableCustom-
// Events, wapConfigurableMixHighlightEvents and recommendScrollEvents --
// accept the parameter and return real football and tennis anyway, so they
// are not listed here, and every event is checked against SPORT below
// regardless. The full multi-day card is served only over POST, which
// SportyBet refuses off its own site.
const FEEDS = [
  ["wapConfigurableUpcomingEvents", {}],
  ["configurableLiveOrPrematchEvents",
    { tournamentId: "sv:league:1", marketId: MARKET_IDS, pageSize: "100", pageNum: "1" }],
];

async function feed([path, params]) {
  const q = new URLSearchParams({ sportId: SPORT, ...params });
  const url = `${BASE}/${path}${q.toString() ? `?${q}` : ""}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) return [];
  const body = await r.json();
  if (body.bizCode !== 10000) return [];
  return collect(body.data);
}

/** Events sit at different depths per feed, so find them by shape. */
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
    const price = parseFloat(o.odds);
    if (isFinite(price)) by[o.desc] = price;
  }
  return by;
}

function normalise(ev) {
  // Never trust the feed's filtering: drop anything that is not vFootball.
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
    sportId: ev.sport.id,
    upcoming: ev.matchStatus === "Not start",
    ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
    dc: dc && dc["Home or Draw"] != null
      ? { home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"] }
      : null,
    ht: ht && ht.Home != null ? { home: ht.Home, draw: ht.Draw, away: ht.Away } : null,
  };
}

/** A later feed may carry a market an earlier one lacked, so merge, don't skip. */
function merge(into, game) {
  const prev = into.get(game.id);
  if (!prev) { into.set(game.id, game); return; }
  prev.dc = prev.dc || game.dc;
  prev.ht = prev.ht || game.ht;
  prev.league = prev.league || game.league;
  prev.kickoff = prev.kickoff || game.kickoff;
}

export default async function handler(req, res) {
  const started = Date.now();
  const settled = await Promise.allSettled(FEEDS.map(feed));
  const reached = settled.filter((s) => s.status === "fulfilled").length;

  if (!reached) {
    res.status(502).json({ ok: false, error: "Could not reach SportyBet." });
    return;
  }

  const byId = new Map();
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    for (const ev of s.value) {
      const game = normalise(ev);
      if (game) merge(byId, game);
    }
  }

  const games = [...byId.values()].sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
  const screenable = games.filter((g) => g.upcoming && g.dc && g.ht).length;
  const sports = [...new Set(games.map((g) => g.sportId))];

  res.setHeader("Cache-Control", "s-maxage=15, stale-while-revalidate=30");
  res.status(200).json({
    ok: true,
    fetchedAt: Date.now(),
    tookMs: Date.now() - started,
    feedsReached: `${reached}/${FEEDS.length}`,
    count: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    screenable,
    sports,
    games,
  });
}
