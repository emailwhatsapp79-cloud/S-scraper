// Full remaining-day vFootball card, over GET.
// option=1 (and the WAP highlight feed) is a ~10-game window.
// option=2 on each virtual league is the rest of today.
import { WANTED } from "./_shape.js";

export const BASE = "https://www.sportybet.com/api/ng/factsCenter";
export const SPORT = "sr:sport:202120001";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MARKET_IDS = "1,10,60";

export const LEAGUES = [
  ["sv:league:1", "England"],
  ["sv:league:2", "Spain"],
  ["sv:league:3", "Italy"],
  ["sv:league:4", "Germany"],
  ["sv:league:5", "France"],
];

async function fetchLeague([tid, fallback]) {
  const q = new URLSearchParams({
    sportId: SPORT, tournamentId: tid, marketId: MARKET_IDS,
    option: "2", timeline: "168", pageSize: "100", pageNum: "1",
  });
  const r = await fetch(`${BASE}/pcUpcomingEvents?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`${fallback} HTTP ${r.status}`);
  const body = await r.json();
  if (body.bizCode !== 10000) throw new Error(`${fallback} bizCode ${body.bizCode}`);
  return collectTournaments(body.data, fallback);
}

function collectTournaments(data, fallback) {
  const found = [];
  for (const t of data?.tournaments || []) {
    const league = [t.categoryName || fallback, t.name].filter(Boolean).join(" · ");
    for (const ev of t.events || []) {
      if (ev?.gameId && ev.homeTeamName) found.push({ ...ev, _league: league });
    }
  }
  return found;
}

export async function fetchCard() {
  const results = await Promise.allSettled(LEAGUES.map(fetchLeague));
  const events = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") events.push(...r.value);
    else errors.push(String(r.reason?.message || r.reason));
  });
  return { events, errors };
}

function legs(market) {
  const by = {};
  for (const o of market.outcomes || []) {
    const p = parseFloat(o.odds);
    if (isFinite(p)) by[o.desc] = p;
  }
  return by;
}

export function normalise(ev) {
  if ((ev.sport || {}).id !== SPORT) return null;
  const got = {};
  for (const m of ev.markets || []) {
    const slot = WANTED[m.desc];
    if (slot && !got[slot]) got[slot] = legs(m);
  }
  const ft = got.ft;
  if (!ft || ft.Home == null || ft.Draw == null || ft.Away == null) return null;
  const dc = got.dc, ht = got.ht;
  const cat = (ev.sport || {}).category || {};
  const tour = cat.tournament || {};
  return {
    id: String(ev.gameId),
    eventId: ev.eventId || null,
    home: ev.homeTeamName || "?",
    away: ev.awayTeamName || "?",
    league: ev._league || [cat.name, tour.name].filter(Boolean).join(" · ") || "",
    kickoff: ev.estimateStartTime || null,
    status: ev.matchStatus || "",
    upcoming: ev.matchStatus === "Not start" &&
      (!ev.estimateStartTime || Number(ev.estimateStartTime) > Date.now()),
    ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
    dc: dc && dc["Home or Draw"] != null
      ? { home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"] }
      : null,
    ht: ht && ht.Home != null ? { home: ht.Home, draw: ht.Draw, away: ht.Away } : null,
  };
}
