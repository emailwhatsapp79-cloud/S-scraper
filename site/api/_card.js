// Full remaining-day vFootball card, over GET.
// option=1 (and the WAP highlight feed) is a ~10-game window.
// option=2 on each virtual league is the rest of today.
import { WANTED, isUpcoming } from "./_shape.js";

export const BASE = "https://www.sportybet.com/api/ng/factsCenter";
export const FOOTBALL_BASE = "https://www.football.com/api/ng/factsCenter";
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

async function getJson(path, params, base = BASE) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${base}/${path}?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  if (body.bizCode !== 10000) throw new Error(`bizCode ${body.bizCode}`);
  return body.data;
}

async function fetchLeague([tid, fallback], base = BASE) {
  const found = [];
  const seen = new Set();
  for (let page = 1; page <= 6; page++) {
    const data = await getJson("pcUpcomingEvents", {
      sportId: SPORT, tournamentId: tid, marketId: MARKET_IDS,
      option: "2", timeline: "168", pageSize: "100", pageNum: String(page),
    }, base);
    const batch = collectTournaments(data, fallback);
    let added = 0;
    for (const ev of batch) {
      const id = String(ev.gameId);
      if (seen.has(id)) continue;
      seen.add(id);
      found.push(ev);
      added++;
    }
    if (batch.length < 100) break;
  }
  return found;
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

function collect(node, found = []) {
  if (Array.isArray(node)) { for (const n of node) collect(n, found); return found; }
  if (!node || typeof node !== "object") return found;
  if (node.gameId && node.homeTeamName) found.push(node);
  for (const v of Object.values(node)) collect(v, found);
  return found;
}

export async function fetchCard(base = BASE) {
  const results = await Promise.allSettled(LEAGUES.map((lg) => fetchLeague(lg, base)));
  const events = [];
  const errors = [];
  results.forEach((r) => {
    if (r.status === "fulfilled") events.push(...r.value);
    else errors.push(String(r.reason?.message || r.reason));
  });
  return { events, errors };
}

export async function fetchLive() {
  const results = await Promise.allSettled(LEAGUES.map(([tid, name]) =>
    getJson("configurableLiveOrPrematchEvents", {
      sportId: SPORT, tournamentId: tid, marketId: MARKET_IDS,
      pageSize: "100", pageNum: "1",
    }).then((data) => collect(data).map((ev) => ({ ...ev, _league: name }))),
  ));
  const events = [];
  for (const r of results) if (r.status === "fulfilled") events.push(...r.value);
  return events;
}

export async function fetchEvent(eventId, extra = {}, base = BASE) {
  if (!eventId) return null;
  try {
    return await getJson("event", { eventId, marketId: MARKET_IDS, ...extra }, base);
  } catch {
    return null;
  }
}

// A live event carries two copies of each market: the live one (product 1,
// status 0, an availableScore and a fresh lastOddsChangeTime) and a frozen
// pre-match copy (product 3). Pick the live copy — freshest odds win — so the
// price reflects the game in play, not the opening line.
function pickMarket(list) {
  return list.slice().sort((a, b) => {
    const la = a.product === 1 ? 1 : 0, lb = b.product === 1 ? 1 : 0;
    if (la !== lb) return lb - la;
    return (Number(b.lastOddsChangeTime) || 0) - (Number(a.lastOddsChangeTime) || 0);
  })[0];
}

function pricesOf(ev) {
  const bySlot = {};
  for (const m of ev.markets || []) {
    const slot = WANTED[m.desc];
    if (slot) (bySlot[slot] = bySlot[slot] || []).push(m);
  }
  const ft = bySlot.ft ? legs(pickMarket(bySlot.ft)) : {};
  const dc = bySlot.dc ? legs(pickMarket(bySlot.dc)) : {};
  return {
    "1": ft.Home ?? null,
    X: ft.Draw ?? null,
    "2": ft.Away ?? null,
    "1X": dc["Home or Draw"] ?? null,
    "12": dc["Home or Away"] ?? null,
    X2: dc["Draw or Away"] ?? null,
  };
}

export function parseScore(s) {
  if (s == null) return null;
  const m = String(s).trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

function ttWinnerPrices(ev) {
  const cands = (ev.markets || []).filter((m) => /^winner$/i.test(String(m.desc || "")));
  if (!cands.length) return {};
  cands.sort((a, b) => ((b.product === 1) - (a.product === 1)));
  const w = {};
  for (const o of cands[0].outcomes || []) {
    const p = parseFloat(o.odds);
    if (!isFinite(p) || p <= 1) continue;
    const d = String(o.desc || "");
    const id = String(o.id || o.outcomeId || "");
    if (/^home$/i.test(d) || id === "4") w["1"] = p;
    else if (/^away$/i.test(d) || id === "5") w["2"] = p;
  }
  return w;
}

function currentPoints(ev, setScore) {
  const gs = Array.isArray(ev.gameScore) ? ev.gameScore : [];
  if (!gs.length) return null;
  const done = setScore ? setScore.home + setScore.away : 0;
  const idx = gs.length > done ? gs.length - 1 : (done === 0 ? 0 : -1);
  if (idx < 0) return null;
  return parseScore(gs[idx]);
}

export function scoreOf(ev) {
  if (!ev) return null;
  const ft = parseScore(ev.setScore);
  const ht = Array.isArray(ev.gameScore) && ev.gameScore[0] ? parseScore(ev.gameScore[0]) : null;
  const status = ev.matchStatus || "";
  const sportId = String((ev.sport && ev.sport.id) || "");
  const isTT = sportId === "sr:sport:20" || /^set\s*\d/i.test(status);
  const live = isTT
    ? /^(set\s*\d|Playing|LIVE)/i.test(status)
    : /^(H1|H2|HT|1H|2H|LIVE)/i.test(status);
  const pts = isTT && live ? currentPoints(ev, ft) : null;
  const prices = isTT ? { ...pricesOf(ev), ...ttWinnerPrices(ev) } : pricesOf(ev);
  return {
    gameId: String(ev.gameId),
    eventId: ev.eventId || null,
    home: ev.homeTeamName || "",
    away: ev.awayTeamName || "",
    status,
    played: pts ? (pts.home + ":" + pts.away) : (ev.playedSeconds || ""),
    setScore: ev.setScore || "",
    ftHome: ft ? ft.home : null,
    ftAway: ft ? ft.away : null,
    htHome: ht ? ht.home : null,
    htAway: ht ? ht.away : null,
    ended: /^end/i.test(status),
    live,
    prices,
  };
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
    upcoming: isUpcoming(ev.matchStatus, ev.estimateStartTime),
    ft: { home: ft.Home, draw: ft.Draw, away: ft.Away },
    dc: dc && dc["Home or Draw"] != null
      ? { home_draw: dc["Home or Draw"], home_away: dc["Home or Away"], draw_away: dc["Draw or Away"] }
      : null,
    ht: ht && ht.Home != null ? { home: ht.Home, draw: ht.Draw, away: ht.Away } : null,
  };
}
