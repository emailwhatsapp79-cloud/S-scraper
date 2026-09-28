// Upcoming tennis off SportyBet (sr:sport:5). Best of three ends 2:0, 2:1, 1:2 or 0:2.
// The call is the set market with the margin taken out. The winner is the side
// of those scores added together, which is sharper than the winner price alone.
const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:5";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const RANK = {
  "3:0": 0, "2:0": 1, "3:1": 2, "2:1": 3, "3:2": 4,
  "2:3": 5, "1:2": 6, "1:3": 7, "0:2": 8, "0:3": 9,
};

async function getJson(params) {
  const q = new URLSearchParams(params);
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  try {
    const r = await fetch(`${BASE}/pcUpcomingEvents?${q}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (body.bizCode !== 10000) throw new Error(`bizCode ${body.bizCode}`);
    return body.data;
  } finally {
    clearTimeout(to);
  }
}

function upcoming(status, start) {
  const st = String(status || "");
  if (/^(end|live|set|playing|walkover|retired)/i.test(st)) return false;
  if (start != null && Number(start) > 0 && Number(start) <= Date.now() - 60000) return false;
  return true;
}

export function fairShares(rows) {
  const raw = (rows || []).map((r) => {
    const p = Number(r.probability);
    if (p > 0 && p < 1) return p;
    const o = Number(r.odds ?? r.price);
    return o > 1 ? 1 / o : 0;
  });
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return raw.map(() => 0);
  return raw.map((p) => p / sum);
}

function sideOf(sel) {
  const m = String(sel || "").match(/^(\d+):(\d+)$/);
  if (!m) return "";
  return Number(m[1]) > Number(m[2]) ? "home" : "away";
}

// Match-win probability q = p^2 * (3 - 2p), p = P(home takes one set).
export function scoresFromWin(q) {
  const want = Math.min(0.99, Math.max(0.01, Number(q) || 0.5));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    const win = mid * mid * (3 - 2 * mid);
    if (win < want) lo = mid;
    else hi = mid;
  }
  const p = (lo + hi) / 2;
  const a = 1 - p;
  return [
    { sel: "2:0", p: p * p },
    { sel: "2:1", p: 2 * p * p * a },
    { sel: "1:2", p: 2 * p * a * a },
    { sel: "0:2", p: a * a },
  ];
}

export function tennisCall(scores) {
  const list = (scores || []).filter((s) => s && s.p > 0);
  let home = 0;
  let away = 0;
  let best = null;
  for (const s of list) {
    if (sideOf(s.sel) === "home") home += s.p;
    else away += s.p;
    if (!best || s.p > best.p) best = s;
  }
  const total = home + away;
  if (total > 0 && Math.abs(total - 1) > 0.02) {
    home /= total;
    away /= total;
  }
  return {
    home, away,
    side: home >= away ? "home" : "away",
    score: best ? best.sel : "",
    scoreP: best ? best.p : 0,
  };
}

function winPrices(ev) {
  const markets = (ev.markets || []).filter((m) => String(m.id) === "186" || /^winner$/i.test(String(m.desc || "")));
  const m = markets[0];
  if (!m) return null;
  const out = { marketId: "186" };
  for (const o of m.outcomes || []) {
    const odds = Number(o.odds);
    if (!(odds > 1) || o.isActive === 0) continue;
    const id = String(o.id || "");
    const slot = /^home$/i.test(String(o.desc || "")) || id === "4" ? "home"
      : /^away$/i.test(String(o.desc || "")) || id === "5" ? "away" : "";
    if (!slot) continue;
    out[slot] = {
      odds,
      outcomeId: id,
      probability: o.probability != null ? String(o.probability) : "",
    };
  }
  if (!out.home || !out.away) return null;
  return out;
}

function scoreRows(ev) {
  const markets = (ev.markets || []).filter((m) => String(m.id) === "199" || /correct score/i.test(String(m.desc || "")));
  const rows = [];
  for (const m of markets) {
    for (const o of m.outcomes || []) {
      const sel = String(o.desc || "").replace("-", ":");
      if (!/^\d+:\d+$/.test(sel)) continue;
      const odds = Number(o.odds);
      if (!(odds > 1) || o.isActive === 0) continue;
      rows.push({
        sel,
        odds,
        marketId: String(m.id || "199"),
        outcomeId: String(o.id || ""),
        specifier: String(m.specifier || ""),
        probability: o.probability != null ? String(o.probability) : "",
      });
    }
  }
  rows.sort((a, b) => (RANK[a.sel] ?? 50) - (RANK[b.sel] ?? 50));
  return rows;
}

export function normaliseTennis(ev, tourn) {
  const home = ev.homeTeamName || "";
  const away = ev.awayTeamName || "";
  if (!home || !away || !ev.eventId) return null;
  const start = ev.estimateStartTime ? Number(ev.estimateStartTime) : null;
  if (!upcoming(ev.matchStatus, start)) return null;
  const win = winPrices(ev);
  let scores = scoreRows(ev);
  let derived = false;
  if (!scores.length && win) {
    const fair = fairShares([
      { odds: win.home.odds, probability: win.home.probability },
      { odds: win.away.odds, probability: win.away.probability },
    ]);
    scores = scoresFromWin(fair[0]).map((s) => ({ ...s, odds: null, marketId: "", outcomeId: "", specifier: "", probability: "" }));
    derived = true;
  }
  const shares = scores.every((s) => s.p > 0) ? scores.map((s) => s.p) : fairShares(scores);
  const priced = scores.map((s, i) => ({ ...s, p: shares[i] }));
  const call = tennisCall(priced);
  const refs = {};
  if (win) {
    refs["1"] = { marketId: "186", outcomeId: win.home.outcomeId, probability: win.home.probability };
    refs["2"] = { marketId: "186", outcomeId: win.away.outcomeId, probability: win.away.probability };
  }
  for (const s of priced) {
    if (!s.outcomeId) continue;
    refs[s.sel] = {
      marketId: s.marketId,
      outcomeId: s.outcomeId,
      probability: s.probability,
      specifier: s.specifier,
    };
  }
  return {
    id: String(ev.gameId || ev.eventId),
    eventId: ev.eventId,
    sport: "tn",
    home, away,
    tourn: tourn || "",
    start,
    status: ev.matchStatus || "",
    derived,
    win: win ? { home: win.home.odds, away: win.away.odds } : null,
    call: {
      side: call.side,
      home: Math.round(call.home * 1000) / 10,
      away: Math.round(call.away * 1000) / 10,
      score: call.score,
      scoreP: Math.round(call.scoreP * 1000) / 10,
    },
    scores: priced.map((s) => ({
      sel: s.sel,
      odds: s.odds,
      p: Math.round(s.p * 1000) / 10,
    })),
    selectionRefs: refs,
  };
}

export async function fetchTennisCard() {
  const found = [];
  const seen = new Set();
  for (let page = 1; page <= 4; page++) {
    const data = await getJson({
      sportId: SPORT, marketId: "186,199", option: "1",
      pageSize: "100", pageNum: String(page),
    });
    let count = 0;
    for (const t of data?.tournaments || []) {
      for (const ev of t.events || []) {
        count++;
        const id = String(ev.eventId || ev.gameId || "");
        if (!id || seen.has(id)) continue;
        const game = normaliseTennis(ev, t.name || "");
        if (!game) continue;
        seen.add(id);
        found.push(game);
      }
    }
    if (count < 100) break;
  }
  found.sort((a, b) => (a.start || 0) - (b.start || 0));
  return found;
}
