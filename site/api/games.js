// Reads the SportyBet vFootball card server-side and returns it normalised.
// Runs on Vercel; the browser cannot call SportyBet directly (cross-origin).

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

// The three markets the screen needs, by the name SportyBet prints.
const WANTED = { "1X2": "ft", "Double Chance": "dc", "1st Half - 1X2": "ht" };
const MARKET_IDS = "1,10,60";

// "Not start" games are the ones still open. The other endpoint is already in play.
const FEEDS = {
  upcoming: "configurableCustomEvents",
  live: "configurableLiveOrPrematchEvents",
};

async function feed(name) {
  const q = new URLSearchParams({
    sportId: SPORT, marketId: MARKET_IDS, pageSize: "100", pageNum: "1",
  });
  const r = await fetch(`${BASE}/${FEEDS[name]}?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`SportyBet returned ${r.status}`);
  const body = await r.json();
  if (body.bizCode !== 10000) throw new Error(body.message || "SportyBet refused the request");
  return body.data;
}

/** The payload nests events under tournaments on one feed and flat on the other. */
function flatten(data) {
  if (!Array.isArray(data)) return [];
  const out = [];
  for (const node of data) {
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node.events)) out.push(...node.events.map((e) => [e, node.name]));
    else if (node.gameId) out.push([node, node.tournamentName || ""]);
  }
  return out;
}

function legs(market) {
  const by = {};
  for (const o of market.outcomes || []) {
    const price = parseFloat(o.odds);
    if (isFinite(price)) by[o.desc] = price;
  }
  return by;
}

function normalise([ev, tournament], state) {
  const got = {};
  for (const m of ev.markets || []) {
    const slot = WANTED[m.desc];
    if (slot && !got[slot]) got[slot] = legs(m);
  }
  const ft = got.ft;
  if (!ft || ft.Home == null || ft.Draw == null || ft.Away == null) return null;

  const game = {
    id: String(ev.gameId ?? ""),
    home: ev.homeTeamName || "?",
    away: ev.awayTeamName || "?",
    league: tournament || "",
    kickoff: ev.estimateStartTime || null,
    status: ev.matchStatus || "",
    state,
    ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
    dc: null,
    ht: null,
  };
  const dc = got.dc;
  if (dc && dc["Home or Draw"] != null) {
    game.dc = {
      home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"],
    };
  }
  const ht = got.ht;
  if (ht && ht.Home != null) game.ht = { home: ht.Home, draw: ht.Draw, away: ht.Away };
  return game;
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  const wantLive = url.searchParams.get("live") === "1";
  const states = wantLive ? ["upcoming", "live"] : ["upcoming"];

  try {
    const settled = await Promise.all(states.map((s) => feed(s).then((d) => [s, d])));
    const byId = new Map();
    for (const [state, data] of settled) {
      for (const entry of flatten(data)) {
        const game = normalise(entry, state);
        // Upcoming wins over live when a game appears on both feeds.
        if (game && game.id && !byId.has(game.id)) byId.set(game.id, game);
      }
    }
    const games = [...byId.values()].sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
    res.setHeader("Cache-Control", "s-maxage=10, stale-while-revalidate=20");
    res.status(200).json({ ok: true, fetchedAt: Date.now(), count: games.length, games });
  } catch (err) {
    res.status(502).json({ ok: false, error: String(err.message || err) });
  }
}
