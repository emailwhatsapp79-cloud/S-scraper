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

function marketOpen(m) {
  return m && (m.status == null || m.status === "" || Number(m.status) === 0);
}

function chooseMarket(markets) {
  const open = (markets || []).filter(marketOpen);
  if (!open.length) return null;
  const pre = open.filter((m) => Number(m.product) !== 1);
  const pool = pre.length ? pre : open;
  return pool.slice().sort((a, b) => (Number(b.lastOddsChangeTime) || 0) - (Number(a.lastOddsChangeTime) || 0))[0];
}

function winPrices(ev) {
  const markets = (ev.markets || []).filter((m) => String(m.id) === "186" || /^winner$/i.test(String(m.desc || "")));
  const open = chooseMarket(markets);
  const m = open || markets[0];
  if (!m) return null;
  const out = { marketId: "186", open: Boolean(open) };
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
  const open = chooseMarket(markets);
  const m = open || markets[0];
  if (!m) return [];
  const rows = [];
  for (const o of m.outcomes || []) {
      const sel = String(o.desc || "").replace("-", ":");
      if (!/^\d+:\d+$/.test(sel)) continue;
      const odds = Number(o.odds);
      if (!(odds > 1) || o.isActive === 0) continue;
      rows.push({
        sel,
        odds,
        open: Boolean(open),
        marketId: String(m.id || "199"),
        outcomeId: String(o.id || ""),
        specifier: String(m.specifier || ""),
        probability: o.probability != null ? String(o.probability) : "",
      });
  }
  rows.sort((a, b) => (RANK[a.sel] ?? 50) - (RANK[b.sel] ?? 50));
  return rows;
}

export function isWomenEvent(tourn, category) {
  const text = [tourn, category].filter(Boolean).join(" ");
  return /\bWTA\b|\bwomen\b|\bITF\s+W\d+/i.test(text);
}

export function drawOf(tourn, home, away) {
  const text = String(tourn || "");
  const names = [home, away].filter(Boolean).join(" ");
  if (/\bdoubles\b/i.test(text) || /\s\/\s/.test(names)) return "doubles";
  if (/\bsingles\b/i.test(text)) return "singles";
  if (/\b(ATP|WTA|ITF|Challenger|UTR)\b/i.test(text)) return "singles";
  return "";
}

export function isSimEvent(ev, tourn, category) {
  const cat = ev?.sport?.category?.name || category || "";
  const text = [tourn, cat, ev?.homeTeamName, ev?.awayTeamName].join(" ");
  return /simulated reality|\bSRL\b|\(srl\)/i.test(text);
}

export function normaliseTennis(ev, tourn, category) {
  const home = ev.homeTeamName || "";
  const away = ev.awayTeamName || "";
  if (!home || !away || !ev.eventId) return null;
  const start = ev.estimateStartTime ? Number(ev.estimateStartTime) : null;
  if (!upcoming(ev.matchStatus, start)) return null;
  const sim = isSimEvent(ev, tourn, category);
  const women = isWomenEvent(tourn, category);
  const draw = drawOf(tourn, home, away);
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
  const matchHeld = /suspend|interrupt/i.test(String(ev.matchStatus || ""));
  const refs = {};
  const winOpen = Boolean(win && win.open !== false) && !matchHeld;
  if (win && winOpen) {
    refs["1"] = { marketId: "186", outcomeId: win.home.outcomeId, probability: win.home.probability };
    refs["2"] = { marketId: "186", outcomeId: win.away.outcomeId, probability: win.away.probability };
  }
  const pricedOpen = priced.filter((s) => s.outcomeId && s.open !== false);
  const scoresOpen = pricedOpen.length > 0 && !matchHeld;
  if (scoresOpen) {
    for (const s of pricedOpen) {
      refs[s.sel] = {
        marketId: s.marketId,
        outcomeId: s.outcomeId,
        probability: s.probability,
        specifier: s.specifier,
      };
    }
  }
  return {
    id: String(ev.gameId || ev.eventId),
    eventId: ev.eventId,
    sport: "tn",
    home, away,
    tourn: sim ? "SIM · " + (tourn || "Simulated Reality") : (tourn || ""),
    sim,
    women,
    draw,
    start,
    status: ev.matchStatus || "",
    suspended: matchHeld || ((Boolean(win) || priced.some((s) => s.outcomeId)) && !winOpen && !scoresOpen),
    winOpen,
    scoresOpen,
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
  async function page(n) {
    const data = await getJson({
      sportId: SPORT, marketId: "186,199", option: "2", timeline: "24",
      pageSize: "100", pageNum: String(n),
    });
    let count = 0;
    const batch = [];
    for (const t of data?.tournaments || []) {
      for (const ev of t.events || []) {
        count++;
        const game = normaliseTennis(ev, t.name || "", t.categoryName || "");
        if (game) batch.push(game);
      }
    }
    return { count, batch };
  }
  const first = await page(1);
  const found = first.batch.slice();
  if (first.count >= 100) {
    const rest = await Promise.all([2, 3, 4, 5, 6].map((n) => page(n).catch(() => ({ count: 0, batch: [] }))));
    for (const part of rest) found.push(...part.batch);
  }
  const seen = new Set();
  const games = [];
  for (const game of found) {
    if (!game.eventId || seen.has(game.eventId)) continue;
    seen.add(game.eventId);
    games.push(game);
  }
  games.sort((a, b) => (a.start || 0) - (b.start || 0));
  return games;
}

function pct1(x) { return Math.round(x * 1000) / 10; }

function sideOfScore(sel) {
  return sideOf(sel);
}

// Move the book call when recent results or an injury list disagree with it.
// The shift is small on form, and large only when a player is actually listed out.
export function shiftCall(call, scores, flags) {
  const base = (Number(call?.home) || 0) / 100;
  let home = base;
  const why = [];
  const f = flags || {};
  if (f.homeOut && f.awayOut) why.push("both listed out");
  else if (f.homeOut) { home = Math.min(home, 0.12); why.push("home listed out"); }
  else if (f.awayOut) { home = Math.max(home, 0.88); why.push("away listed out"); }
  else {
    let nudge = 0;
    if (f.homeN >= 4 && f.awayN >= 4) {
      const gap = f.homeWins / f.homeN - f.awayWins / f.awayN;
      if (Math.abs(gap) >= 0.35) nudge = Math.sign(gap) * Math.min(0.06, Math.abs(gap) * 0.08);
    }
    if (f.homeRetire) nudge -= 0.03;
    if (f.awayRetire) nudge += 0.03;
    nudge = Math.max(-0.06, Math.min(0.06, nudge));
    if (Math.abs(nudge) >= 0.02) {
      let next = home + nudge;
      if (nudge > 0) next = Math.min(0.94, next);
      else next = Math.max(0.06, next);
      if (nudge > 0 && next < home) next = home;
      if (nudge < 0 && next > home) next = home;
      if (Math.abs(next - home) >= 0.015) {
        home = next;
        why.push(nudge > 0 ? "home form" : "away form");
      }
    }
  }
  const rows = (scores || []).map((s) => ({ sel: s.sel, odds: s.odds, p: (Number(s.p) || 0) / 100 }));
  let h = 0, a = 0;
  for (const s of rows) (sideOfScore(s.sel) === "home" ? (h += s.p) : (a += s.p));
  const nh = Math.min(0.97, Math.max(0.03, home));
  const na = 1 - nh;
  if (h > 0) for (const s of rows) if (sideOfScore(s.sel) === "home") s.p *= nh / h;
  if (a > 0) for (const s of rows) if (sideOfScore(s.sel) !== "home") s.p *= na / a;
  const sum = rows.reduce((n, s) => n + s.p, 0) || 1;
  for (const s of rows) s.p /= sum;
  const next = tennisCall(rows);
  return {
    why,
    home,
    call: {
      side: next.side,
      home: pct1(next.home),
      away: pct1(next.away),
      score: next.score,
      scoreP: pct1(next.scoreP),
    },
    scores: rows.map((s) => ({ sel: s.sel, odds: s.odds ?? null, p: pct1(s.p) })),
  };
}

export function nameKey(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .sort()
    .join("|");
}

function dayStamp(offset) {
  const d = new Date(Date.now() + offset * 86400000);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}

async function s24(path) {
  const target = "https://scores24.live/rapi" + path;
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 4500);
  const hdr = {
    "User-Agent": UA,
    Accept: "application/json",
    Origin: "https://scores24.live",
    Referer: "https://scores24.live/en/tennis",
  };
  try {
    const direct = await fetch(target, { headers: hdr, signal: ac.signal });
    if (direct.ok) return await direct.json();
    const key = process.env.GATE_SECRET || process.env.CRON_SECRET || "";
    const origins = [];
    if (process.env.VERCEL_PROJECT_PRODUCTION_URL) origins.push("https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL);
    if (process.env.VERCEL_URL) origins.push("https://" + process.env.VERCEL_URL);
    for (const origin of origins) {
      const u = origin + "/api/s24-proxy?kind=rapi&u=" + encodeURIComponent(target);
      const r = await fetch(u, { headers: { "x-fill-key": key, Accept: "application/json" }, signal: ac.signal });
      if (r.ok) return await r.json();
    }
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(to);
  }
}

async function loadIndex() {
  const map = new Map();
  for (const off of [-1, 0, 1, 2]) {
    const day = dayStamp(off);
    const q = new URLSearchParams();
    q.append("date_between[]", day + " 00:00:00");
    q.append("date_between[]", day + " 23:59:59");
    q.set("lang", "en");
    q.set("is_bot", "false");
    const body = await s24("/sport/tennis/leagues?" + q);
    for (const league of body?.data || []) {
      for (const m of league.matches || []) {
        const teams = m.teams || [];
        if (teams.length < 2 || !m.slug) continue;
        const keys = [nameKey(teams[0].name), nameKey(teams[1].name)].sort().join("~");
        if (!map.has(keys)) {
          map.set(keys, {
            slug: m.slug,
            surface: m.uniqueTournament?.surface || m.unique_tournament?.surface || "",
            players: teams.slice(0, 2).map((t) => ({ name: t.name, slug: t.slug, key: nameKey(t.name) })),
          });
        }
      }
    }
  }
  return map;
}

function person(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = raw.name || raw.player?.name || raw.player_name || "";
  const why = raw.reason?.name || raw.reason || raw.type || raw.status || raw.description || "out";
  if (!name && !why) return null;
  return { name: String(name || ""), why: String(why) };
}

function readMissing(data) {
  const raw = data?.missing_players || data?.missingPlayers || [];
  const home = [];
  const away = [];
  if (Array.isArray(raw[0]) || Array.isArray(raw[1])) {
    for (const p of raw[0] || []) { const x = person(p); if (x) home.push(x); }
    for (const p of raw[1] || []) { const x = person(p); if (x) away.push(x); }
  }
  return { home, away };
}

function readSets(body, slug) {
  const edges = body?.data?.edges || [];
  const rows = [];
  for (const e of edges) {
    const n = e.node || e;
    if (!n.is_finished) continue;
    const teams = n.teams || [];
    const idx = teams.findIndex((t) => t.slug === slug);
    if (idx < 0) continue;
    const m = String(n.result_score || "").match(/^(\d+)\s*:\s*(\d+)$/);
    if (!m) continue;
    const left = Number(m[1]);
    const right = Number(m[2]);
    const mine = idx === 0 ? left : right;
    const opp = idx === 0 ? right : left;
    const sel = mine + ":" + opp;
    if (sel !== "2:0" && sel !== "2:1" && sel !== "1:2" && sel !== "0:2") continue;
    rows.push({
      sel,
      surface: n.unique_tournament?.surface || n.uniqueTournament?.surface || "",
    });
    if (rows.length >= 16) break;
  }
  return rows;
}

function straightWeight(rows, surface, losses) {
  const want = losses ? ["0:2", "1:2"] : ["2:0", "2:1"];
  const bag = losses ? "0:2" : "2:0";
  let w = 0;
  let n = 0;
  for (const r of rows) {
    if (!want.includes(r.sel)) continue;
    const wt = surface && r.surface === surface ? 2 : 1;
    n += wt;
    if (r.sel === bag) w += wt;
  }
  return { w, n };
}

// Winner stays with the book. Only the most likely score can be marked ahead.
// A deciding set the book is cheap on is not a pick if another score is likelier.
export function scoreEdge(qHome, homeRows, awayRows, bookScores, surface) {
  const q = Math.min(0.97, Math.max(0.03, Number(qHome) || 0.5));
  const iidH = (() => {
    const made = scoresFromWin(q);
    const a = made.find((s) => s.sel === "2:0").p;
    const b = made.find((s) => s.sel === "2:1").p;
    return a / (a + b);
  })();
  const iidA = (() => {
    const made = scoresFromWin(1 - q);
    const a = made.find((s) => s.sel === "2:0").p;
    const b = made.find((s) => s.sel === "2:1").p;
    return a / (a + b);
  })();
  const homeWins = straightWeight(homeRows, surface, false);
  const awayLosses = straightWeight(awayRows, surface, true);
  const awayWins = straightWeight(awayRows, surface, false);
  const homeLosses = straightWeight(homeRows, surface, true);
  const hn = homeWins.n + awayLosses.n;
  const an = awayWins.n + homeLosses.n;
  if (hn < 6 || an < 6) return null;
  const shrink = 8;
  const rH = (homeWins.w + awayLosses.w + iidH * shrink) / (hn + shrink);
  const rA = (awayWins.w + homeLosses.w + iidA * shrink) / (an + shrink);
  const ours = [
    { sel: "2:0", p: q * rH },
    { sel: "2:1", p: q * (1 - rH) },
    { sel: "1:2", p: (1 - q) * (1 - rA) },
    { sel: "0:2", p: (1 - q) * rA },
  ];
  const sum = ours.reduce((n, s) => n + s.p, 0) || 1;
  for (const s of ours) s.p /= sum;
  const mode = ours.reduce((a, b) => (b.p > a.p ? b : a));
  if (mode.p < 0.4) return { ours, edge: null };
  const row = (bookScores || []).find((b) => b.sel === mode.sel);
  if (!row) return { ours, edge: null };
  const book = (Number(row.p) || 0) / 100;
  const gap = mode.p - book;
  if (gap < 0.08) return { ours, edge: null };
  return { ours, edge: { sel: mode.sel, gap, ours: mode.p, book } };
}

// The pick follows the book's short score. A little above that price can be
// marked ahead. A long price on the other side is never the pick.
export function stanceOf(ours, bookScores) {
  const rows = bookScores || [];
  let top = null;
  for (const b of rows) {
    if (!top || Number(b.p) > Number(top.p)) top = b;
  }
  if (!top) return { ahead: null, withBook: null };
  const mine = (ours || []).find((s) => s.sel === top.sel);
  const book = (Number(top.p) || 0) / 100;
  const oursP = mine ? mine.p : book;
  const gap = oursP - book;
  const odds = Number(top.odds);
  if (!(odds > 1)) return { ahead: null, withBook: null };
  if (odds <= 2.5 && gap >= 0.06 && gap <= 0.18 && oursP >= 0.45) {
    return { ahead: { sel: top.sel, ours: oursP, book, gap }, withBook: null };
  }
  if (odds <= 1.7 && gap >= -0.08) return { ahead: null, withBook: { sel: top.sel } };
  return { ahead: null, withBook: null };
}

function pullText(url) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), 8000);
  return fetch(url, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: ac.signal,
  }).then((r) => (r.ok ? r.text() : "")).catch(() => "").finally(() => clearTimeout(to));
}

export function playersMatch(a, b) {
  const A = nameKey(a).split("|").filter((t) => t.length >= 4);
  const B = nameKey(b).split("|").filter((t) => t.length >= 4);
  if (!A.length || !B.length) return false;
  return A.some((t) => B.includes(t));
}

function flipScore(sel) {
  const m = String(sel || "").match(/^(\d+)[:-](\d+)$/);
  return m ? m[2] + ":" + m[1] : "";
}

export function parsePredix(html) {
  const out = [];
  const blocks = String(html || "").split("player-name player-one").slice(1);
  for (const block of blocks) {
    const home = block.match(/>([^<]+)<\/a>/);
    const away = block.match(/player-two">\s*(?:<a[^>]*>)?([^<]+)/);
    const probs = [...block.matchAll(/aria-valuenow="([\d.]+)"/g)].map((m) => Number(m[1]));
    const score = block.match(/Most likely set score:[\s\S]{0,120}?(\d)\s*[-–]\s*(\d)/);
    const scoreP = block.match(/ai-extra-prob">\((\d+(?:\.\d+)?)%\)/);
    if (!home || !away || probs.length < 2) continue;
    out.push({
      home: home[1].trim(),
      away: away[1].replace(/<[^>]+>/g, "").trim(),
      homeP: probs[0],
      awayP: probs[1],
      score: score ? score[1] + ":" + score[2] : "",
      scoreP: scoreP ? Number(scoreP[1]) : null,
    });
  }
  return out;
}

export function parseTpTips(html) {
  const out = [];
  for (const m of String(html || "").matchAll(/visually-hidden">([^<]+)</g)) {
    const text = m[1];
    if (!/Upcoming/i.test(text)) continue;
    const vs = text.match(/^(.+?)\s+vs\s+(.+?),/);
    const tip = text.match(/Best AI tip:\s+([^,]+),\s+odds\s+[\d.]+,\s+confidence\s+([\d.]+)/i);
    if (!vs || !tip) continue;
    const pick = tip[1].trim();
    if (/^[OU]\d/.test(pick)) continue;
    out.push({ home: vs[1].trim(), away: vs[2].trim(), pick, conf: Number(tip[2]) });
  }
  return out;
}

export function readOutside(game, bag) {
  const predixRow = (bag?.predix || []).find((row) => (
    (playersMatch(game.home, row.home) && playersMatch(game.away, row.away)) ||
    (playersMatch(game.home, row.away) && playersMatch(game.away, row.home))
  ));
  let predix = null;
  if (predixRow) {
    const direct = playersMatch(game.home, predixRow.home) && playersMatch(game.away, predixRow.away);
    predix = direct ? predixRow : {
      ...predixRow,
      homeP: predixRow.awayP,
      awayP: predixRow.homeP,
      score: flipScore(predixRow.score),
    };
  }
  const tpRow = (bag?.tp || []).find((row) => (
    (playersMatch(game.home, row.home) && playersMatch(game.away, row.away)) ||
    (playersMatch(game.home, row.away) && playersMatch(game.away, row.home))
  ));
  let tp = null;
  if (tpRow) {
    const pickHome = playersMatch(game.home, tpRow.pick);
    const pickAway = playersMatch(game.away, tpRow.pick);
    if (pickHome || pickAway) tp = { side: pickHome ? "home" : "away", conf: tpRow.conf, pick: tpRow.pick };
  }
  const predixSide = predix ? (predix.homeP >= predix.awayP ? "home" : "away") : null;
  const predixP = predix ? Math.max(predix.homeP, predix.awayP) : null;
  const split = !!(predixSide && tp && tp.side !== predixSide);
  const side = split ? null : (predixSide || (tp && tp.side) || null);
  const sure = !split && ((predixP != null && predixP >= 65) || (!predix && tp && tp.conf >= 7));
  const close = !split && predixP != null && predixP >= 42 && predixP < 58;
  return {
    found: !!(predix || tp),
    predixSide,
    predixP,
    score: predix ? predix.score : "",
    scoreP: predix ? predix.scoreP : null,
    tp,
    split,
    side,
    sure,
    close,
  };
}

function addOutsideNote(game, text) {
  if (!text) return;
  if (!game.context) game.context = { source: "outside", note: text, home: null, away: null };
  else {
    const note = String(game.context.note || "")
      .replace(/\s*·?\s*(?:A little ahead|Ahead) of the book on \d+:\d+/ig, "")
      .replace(/\s*·?\s*With the book on \d+:\d+/ig, "")
      .replace(/^\s*·\s*/, "")
      .trim();
    game.context.note = [note, text].filter(Boolean).join(" · ");
  }
}

function bookSideOf(game) {
  const home = Number(game.call?.home);
  const away = Number(game.call?.away);
  if (home || away) return home >= away ? "home" : "away";
  const ho = Number(game.win?.home);
  const ao = Number(game.win?.away);
  if (ho > 1 && ao > 1) return ho <= ao ? "home" : "away";
  return "home";
}

// Outside sites are read before a mark. A sure agreed winner can only be the
// straight-set score. A close match may take the deciding score they name.
// If they disagree with each other, nothing is marked.
export function applyOutside(game, outside) {
  if (!outside) return game;
  const who = outside.side === "away" ? game.away : game.home;
  const label = outside.found
    ? (outside.predixP != null
      ? "Predix " + String(who || "").split(",")[0].trim().split(/\s+/).pop() + " " + Math.round(outside.predixP) + "%" + (outside.score ? " · " + outside.score.replace(":", "–") : "")
      : "TennisPredictions " + (outside.tp?.pick || "") + " " + outside.tp?.conf + "/10")
    : "";
  game.outside = {
    found: outside.found,
    side: outside.side,
    p: outside.predixP,
    score: outside.score || "",
    split: !!outside.split,
    sure: !!outside.sure,
    close: !!outside.close,
  };
  if (!outside.found) {
    if (game.ahead) delete game.ahead;
    if (game.called) delete game.called;
    return game;
  }
  if (outside.split) {
    delete game.ahead;
    delete game.withBook;
    delete game.called;
    addOutsideNote(game, "Predix and TennisPredictions disagree. No mark.");
    return game;
  }
  const bookSide = bookSideOf(game);
  if (outside.sure && outside.side && outside.side !== bookSide) {
    delete game.ahead;
    delete game.withBook;
    delete game.called;
    addOutsideNote(game, label + ". They are sure, the book is not. No mark.");
    return game;
  }
  const straight = outside.side === "away" ? "0:2" : "2:0";
  const theirScore = outside.score;
  const deciding = theirScore === "2:1" || theirScore === "1:2";
  if (outside.sure && !deciding) {
    if (game.ahead && game.ahead.sel !== straight) delete game.ahead;
    if (game.withBook && game.withBook.sel !== straight) delete game.withBook;
    delete game.called;
    if (!game.ahead && !game.withBook && (game.scores || []).some((s) => s.sel === straight)) {
      game.withBook = { sel: straight };
    }
    addOutsideNote(game, label + ". Sure, so only " + straight.replace(":", "–") + ".");
    return game;
  }
  if (deciding && (outside.close || !outside.sure)) {
    const row = (game.scores || []).find((s) => s.sel === theirScore);
    delete game.ahead;
    delete game.withBook;
    if (row && Number(row.odds) > 1 && Number(row.odds) <= 6 && Number(row.p) >= 18) {
      game.called = { sel: theirScore, by: "predix", p: Number(row.p) };
      if (game.call) game.call = { ...game.call, score: theirScore, scoreP: Number(row.p) };
    }
    addOutsideNote(game, label + ". Close, so " + theirScore.replace(":", "–") + " is allowed.");
    return game;
  }
  delete game.ahead;
  delete game.called;
  addOutsideNote(game, label);
  return game;
}

let outsideCache = { at: 0, bag: null };
async function loadOutside() {
  if (outsideCache.bag && Date.now() - outsideCache.at < 8 * 60 * 1000) return outsideCache.bag;
  const [predixHtml, tpHtml] = await Promise.all([
    pullText("https://www.predixsport.com/tennis_predictions"),
    pullText("https://tennispredictions.ai/"),
  ]);
  const bag = { predix: parsePredix(predixHtml), tp: parseTpTips(tpHtml) };
  outsideCache = { at: Date.now(), bag };
  return bag;
}

function readForm(body, slug) {
  const edges = body?.data?.edges || [];
  const dots = [];
  let wins = 0;
  let retire = false;
  let seen = 0;
  for (const e of edges) {
    const n = e.node || e;
    if (!n.is_finished && String(n.status?.name || "") !== "retired") continue;
    const teams = n.teams || [];
    const idx = teams.findIndex((t) => t.slug === slug);
    if (idx < 0) continue;
    const winner = Number(n.winner);
    const won = winner === idx + 1;
    const retired = /retir|walkover|abandoned/i.test(String(n.status?.name || ""));
    seen++;
    if (seen <= 5) {
      dots.push(won ? "W" : "L");
      if (won) wins++;
    }
    if (seen <= 3 && retired && !won) retire = true;
    if (seen >= 5 && retire) break;
    if (seen >= 8) break;
  }
  return { dots, wins, n: Math.min(seen, 5), retire };
}

async function pool(items, n, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const cur = items[i++];
      try { await fn(cur); } catch { /* one player must not blank the card */ }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

function holdSim(g) {
  if (!g?.sim) return false;
  delete g.ahead;
  delete g.withBook;
  delete g.called;
  delete g.book;
  g.context = {
    source: "sim",
    note: "Simulated. Not a real match. Real player form does not count.",
    home: null,
    away: null,
  };
  return true;
}

export async function enrichTennis(games) {
  for (const g of games || []) holdSim(g);
  const outsideBag = await loadOutside().catch(() => ({ predix: [], tp: [] }));
  const index = await loadIndex();
  if (!index.size) {
    for (const g of games || []) {
      if (holdSim(g)) continue;
      applyOutside(g, readOutside(g, outsideBag));
    }
    return games;
  }
  const picked = [];
  for (const g of games) {
    if (g.sim) continue;
    const hit = index.get([nameKey(g.home), nameKey(g.away)].sort().join("~"));
    if (!hit) continue;
    picked.push({ g, hit });
    if (picked.length >= 20) break;
  }
  const hist = new Map();
  function history(slug) {
    if (!hist.has(slug)) hist.set(slug, s24("/teams/tennis/" + encodeURIComponent(slug) + "/matches?lang=en&first=20&audience=en"));
    return hist.get(slug);
  }
  await pool(picked, 6, async ({ g, hit }) => {
    const homeP = hit.players.find((p) => p.key === nameKey(g.home)) || hit.players[0];
    const awayP = hit.players.find((p) => p.key === nameKey(g.away)) || hit.players[1];
    const [lineups, homeBody, awayBody] = await Promise.all([
      s24("/matches/tennis/" + hit.slug + "/lineups?lang=en"),
      history(homeP.slug),
      history(awayP.slug),
    ]);
    const teams = lineups?.data?.teams || [];
    const missing = readMissing(lineups?.data);
    const rankOf = (slug) => {
      const team = teams.find((t) => t.slug === slug);
      const row = team?.lineups?.start?.[0];
      const rank = Number(row?.ranking);
      return rank > 0 ? rank : null;
    };
    const listed = (list, key) => list.some((p) => nameKey(p.name) === key);
    const homeForm = readForm(homeBody, homeP.slug);
    const awayForm = readForm(awayBody, awayP.slug);
    const homeOut = listed(missing.home, homeP.key) || listed(missing.away, homeP.key);
    const awayOut = listed(missing.home, awayP.key) || listed(missing.away, awayP.key);
    const whyOf = (key) => {
      const p = missing.home.concat(missing.away).find((x) => nameKey(x.name) === key);
      return p ? p.why : "";
    };
    const flags = {
      homeN: homeForm.n, awayN: awayForm.n,
      homeWins: homeForm.wins, awayWins: awayForm.wins,
      homeRetire: homeForm.retire, awayRetire: awayForm.retire,
      homeOut, awayOut,
    };
    const bookScores = (g.scores || []).map((s) => ({ sel: s.sel, p: s.p, odds: s.odds }));
    const qBook = (Number(g.call?.home) || 50) / 100;
    const moved = shiftCall(g.call, g.scores, flags);
    if (moved.why.length) {
      g.book = { home: g.call.home, away: g.call.away, score: g.call.score };
      g.call = moved.call;
      g.scores = g.scores.map((s) => {
        const nxt = moved.scores.find((x) => x.sel === s.sel);
        return nxt ? { ...s, p: nxt.p } : s;
      });
    }
    const last = (name) => {
      const t = String(name || "");
      if (t.includes(",")) return t.split(",")[0].trim();
      const p = t.split(/\s+/);
      return p[p.length - 1] || t;
    };
    const bits = [];
    if (homeOut) bits.push(last(g.home) + " listed out" + (whyOf(homeP.key) ? " (" + whyOf(homeP.key) + ")" : ""));
    if (awayOut) bits.push(last(g.away) + " listed out" + (whyOf(awayP.key) ? " (" + whyOf(awayP.key) + ")" : ""));
    if (!homeOut && !awayOut && homeForm.n >= 4 && awayForm.n >= 4) {
      const gap = homeForm.wins / homeForm.n - awayForm.wins / awayForm.n;
      if (gap >= 0.35) bits.push(last(g.home) + " won " + homeForm.wins + " of last " + homeForm.n);
      else if (gap <= -0.35) bits.push(last(g.away) + " won " + awayForm.wins + " of last " + awayForm.n);
    }
    if (homeForm.retire) bits.push(last(g.home) + " retired recently");
    if (awayForm.retire) bits.push(last(g.away) + " retired recently");
    const edge = scoreEdge(qBook, readSets(homeBody, homeP.slug), readSets(awayBody, awayP.slug), bookScores, hit.surface || "");
    const ours = edge && edge.ours
      ? edge.ours
      : bookScores.map((b) => ({ sel: b.sel, p: (Number(b.p) || 0) / 100 }));
    const stance = stanceOf(ours, bookScores);
    if (stance.ahead && edge && edge.ours) {
      const e = stance.ahead;
      g.ahead = {
        sel: e.sel,
        ours: pct1(e.ours),
        book: pct1(e.book),
      };
      g.scores = g.scores.map((s) => {
        const nxt = edge.ours.find((x) => x.sel === s.sel);
        return nxt ? { ...s, p: pct1(nxt.p) } : s;
      });
      const summed = tennisCall(edge.ours);
      g.call = {
        side: summed.side,
        home: pct1(summed.home),
        away: pct1(summed.away),
        score: e.sel,
        scoreP: pct1(e.ours),
      };
      bits.push("A little ahead of the book on " + e.sel);
    } else if (stance.withBook) {
      g.withBook = stance.withBook;
      bits.push("With the book on " + stance.withBook.sel);
    }
    g.context = {
      source: "scores24",
      surface: hit.surface || "",
      note: bits.join(" · "),
      home: { dots: homeForm.dots, rank: rankOf(homeP.slug), out: homeOut },
      away: { dots: awayForm.dots, rank: rankOf(awayP.slug), out: awayOut },
    };
  });
  for (const g of games || []) {
    if (holdSim(g)) continue;
    applyOutside(g, readOutside(g, outsideBag));
  }
  return games;
}

const MIN_RECORD = 12;

export function recordVerdict(rows) {
  const done = (rows || []).filter((r) => r.hit === true || r.hit === false);
  const open = (rows || []).length - done.length;
  if (!done.length) {
    return { n: 0, hits: 0, open, avgOurs: null, avgBook: null, oursBrier: null, bookBrier: null, used: "early" };
  }
  let hits = 0, ours = 0, book = 0, ob = 0, bb = 0;
  for (const r of done) {
    const y = r.hit ? 1 : 0;
    if (y) hits++;
    const po = (Number(r.ours) || 0) / 100;
    const pb = (Number(r.book) || 0) / 100;
    ours += po;
    book += pb;
    ob += (po - y) ** 2;
    bb += (pb - y) ** 2;
  }
  const n = done.length;
  const oursBrier = ob / n;
  const bookBrier = bb / n;
  const used = n < MIN_RECORD ? "early" : (oursBrier + 0.005 < bookBrier ? "ours" : "book");
  return {
    n, hits, open,
    avgOurs: Math.round(ours / n * 1000) / 10,
    avgBook: Math.round(book / n * 1000) / 10,
    oursBrier: Math.round(oursBrier * 1000) / 1000,
    bookBrier: Math.round(bookBrier * 1000) / 1000,
    used,
  };
}

export function applyRecord(games, verdict) {
  if (!verdict || verdict.used !== "book") return games;
  for (const g of games || []) {
    if (!g.ahead) continue;
    delete g.ahead;
    if (g.context && g.context.note) {
      g.context.note = String(g.context.note)
        .replace(/\s*·?\s*(?:A little ahead|Ahead) of the book on \d+:\d+/i, "")
        .replace(/^\s*·\s*/, "")
        .trim();
    }
  }
  return games;
}

let callsReady = false;
async function ensureCalls() {
  if (callsReady) return;
  const { sql } = await import("./_db.js");
  await sql`CREATE TABLE IF NOT EXISTS tn_calls (
    event_id TEXT PRIMARY KEY,
    home TEXT, away TEXT, tourn TEXT,
    start_at BIGINT,
    score TEXT,
    ours DOUBLE PRECISION,
    book DOUBLE PRECISION,
    odds DOUBLE PRECISION,
    result TEXT,
    hit BOOLEAN,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  callsReady = true;
  await sql`CREATE TABLE IF NOT EXISTS tn_books (
    event_id TEXT PRIMARY KEY,
    home TEXT, away TEXT, tourn TEXT,
    start_at BIGINT,
    score TEXT,
    winner TEXT,
    score_odds DOUBLE PRECISION,
    winner_odds DOUBLE PRECISION,
    result TEXT,
    score_hit BOOLEAN,
    winner_hit BOOLEAN,
    hold TEXT,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`ALTER TABLE tn_books ADD COLUMN IF NOT EXISTS hold TEXT`;
  return sql;
}

function matchOver(status) {
  const s = String(status || "").trim();
  if (!s) return false;
  if (/^(set\s*\d|not\s*start|interrupt|playing|live|1st|2nd|3rd|4th|5th)/i.test(s)) return false;
  return /^(end|finish|final|retir|walkover|abandon|closed|cancel)/i.test(s);
}

function stillPlaying(ev) {
  if (!ev) return false;
  const s = String(ev.matchStatus || "");
  if (/interrupt|suspend|delay|postpon/i.test(s)) return true;
  return /^(set\s*\d|not\s*start|playing|live|1st|2nd|3rd|4th|5th)/i.test(s);
}

function holdOf(ev) {
  const s = String(ev && ev.matchStatus || "");
  if (/interrupt/i.test(s)) return "Interrupted";
  if (/suspend/i.test(s)) return "Suspended";
  if (/delay|postpon/i.test(s)) return "Delayed";
  return "";
}

function setTally(ev) {
  if (!matchOver(ev && ev.matchStatus)) return null;
  const raw = String(ev.setScore || "").trim();
  const direct = raw.match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!direct) return null;
  const hs = Number(direct[1]);
  const as = Number(direct[2]);
  if (hs < 2 && as < 2) return null;
  if (hs > 3 || as > 3) return null;
  return hs + ":" + as;
}

export function finishedSets(ev) {
  if (!ev) return null;
  const sel = setTally(ev);
  if (!sel) return null;
  return {
    result: sel,
    hitOf(score) {
      return sel === score;
    },
  };
}

export function splitBooked(rows) {
  const list = rows || [];
  function pack(kind) {
    const mine = list.filter((r) => (
      kind === "score" ? /^\d+:\d+$/.test(String(r.selection || "")) : (r.selection === "1" || r.selection === "2")
    ));
    const done = mine.filter((r) => r.won === "yes" || r.won === "no" || r.won === true || r.won === false);
    const hitOf = (r) => r.won === "yes" || r.won === true;
    return {
      hits: done.filter(hitOf).length,
      n: done.length,
      open: mine.length - done.length,
      rows: mine.slice(0, 80).map(mapBooked),
    };
  }
  const mapped = list.slice(0, 80).map(mapBooked);
  const slips = [];
  const by = new Map();
  for (const r of mapped) {
    const id = r.slipId || "one";
    if (!by.has(id)) {
    const slip = {
      id, code: r.code || "", url: r.url || "", at: r.at || null,
      stake: r.stake, potential: r.potential, returned: r.returned,
      orderId: r.orderId || "", payWith: r.payWith || "", rows: [],
    };
      by.set(id, slip);
      slips.push(slip);
    }
    by.get(id).rows.push(r);
  }
  return { winners: pack("winner"), scores: pack("score"), rows: mapped, slips };
}

function mapBooked(r) {
  return {
    eventId: r.eventId || r.event_id || "",
    home: r.home || "",
    away: r.away || "",
    tourn: r.tourn || r.league || "",
    start: r.start || (r.kickoff ? Number(r.kickoff) : null),
    selection: String(r.selection || ""),
    label: r.label || r.selection_label || String(r.selection || ""),
    price: r.price == null ? null : Number(r.price),
    result: r.result || r.set_score || r.setScore || null,
    status: /interrupt|suspend|delay|postpon/i.test(String(r.match_status || "")) ? String(r.match_status) : "",
    hit: r.won == null ? null : (r.won === "yes" || r.won === true),
    slipId: r.slipId || r.slip_id || "",
    code: r.code || r.share_code || "",
    url: r.url || r.share_url || "",
    at: r.at || (r.created_at ? new Date(r.created_at).getTime() : null),
    stake: r.stake == null ? null : Number(r.stake),
    potential: r.potential == null ? null : Number(r.potential),
    returned: r.returned == null ? null : Number(r.returned),
    orderId: r.orderId || r.order_id || "",
    payWith: r.payWith || r.pay_with || "",
    pos: Number(r.pos) || 0,
  };
}

export async function bookedTennisRecord() {
  const { sql } = await import("./_db.js");
  const { fetchEvent } = await import("./_card.js");
  await ensureCalls();
  const raw = await sql`
    SELECT l.event_id, l.home, l.away, l.league, l.kickoff, l.selection, l.selection_label,
           l.price, l.won, l.set_score, l.match_status, l.slip_id, l.game_id, l.pos,
           s.share_code, s.share_url, s.created_at, s.stake, s.potential, s.returned,
           s.order_id, s.pay_with
    FROM slip_legs l
    JOIN slips s ON s.id = l.slip_id
    WHERE l.sport = 'tn'
    ORDER BY s.created_at DESC NULLS LAST, l.pos ASC
    LIMIT 80`;
  const rows = raw.map((r) => ({ ...r }));
  const due = [];
  const suspect = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row.event_id || seen.has(row.event_id)) continue;
    const started = Number(row.kickoff) > 0 && Number(row.kickoff) <= Date.now() - 20 * 60 * 1000;
    const recent = !(Number(row.kickoff) > 0) || Number(row.kickoff) > Date.now() - 36 * 60 * 60 * 1000;
    if (row.won == null && started) {
      seen.add(row.event_id);
      due.push(row);
    } else if (row.won != null && recent) {
      seen.add(row.event_id);
      suspect.push(row);
    }
  }
  async function readFinish(eventId) {
    const ev = await fetchEvent(eventId, { marketId: "186" });
    if (!ev) return null;
    if (stillPlaying(ev)) return { playing: true, status: ev.matchStatus || "" };
    const fin = finishedSets(ev);
    if (!fin || !/^\d+:\d+$/.test(String(fin.result || ""))) return { pending: true };
    return { done: true, result: fin.result, status: ev.matchStatus || "Ended" };
  }
  await pool(due.slice(0, 6), 6, async (row) => {
    const fin = await readFinish(row.event_id);
    if (!fin || !fin.done) return;
    const [hs, as] = String(fin.result).split(":").map(Number);
    for (const leg of rows) {
      if (leg.event_id !== row.event_id || leg.won != null) continue;
      let hit = null;
      if (/^\d+:\d+$/.test(String(leg.selection || ""))) hit = leg.selection === fin.result;
      else if (leg.selection === "1") hit = hs > as;
      else if (leg.selection === "2") hit = as > hs;
      if (hit == null) continue;
      leg.won = hit ? "yes" : "no";
      leg.set_score = fin.result;
      await sql`
        UPDATE slip_legs SET won = ${leg.won}, set_score = ${fin.result}, match_status = ${fin.status}
        WHERE slip_id = ${leg.slip_id} AND game_id = ${leg.game_id}`;
    }
  });
  const cleared = new Set();
  await pool(suspect.slice(0, 6), 6, async (row) => {
    const fin = await readFinish(row.event_id);
    if (!fin || !fin.playing) return;
    for (const leg of rows) {
      if (leg.event_id !== row.event_id) continue;
      leg.won = null;
      leg.set_score = null;
      leg.match_status = fin.status;
      cleared.add(leg.slip_id);
      await sql`
        UPDATE slip_legs
        SET won = NULL, set_score = NULL, match_status = ${fin.status}, ft_home = NULL, ft_away = NULL
        WHERE slip_id = ${leg.slip_id} AND game_id = ${leg.game_id}`;
    }
  });
  for (const id of cleared) {
    await sql`
      UPDATE slips SET status = 'live', returned = NULL, settled_at = NULL
      WHERE id = ${id} AND status IN ('won', 'lost')`;
  }
  return splitBooked(rows);
}

export function bookMark(g) {
  if (!g || g.sim || g.ahead || g.called || !g.eventId) return null;
  let score = g.withBook && g.withBook.sel;
  if (!score && !g.context) {
    let short = 99;
    let sel = "";
    for (const s of g.scores || []) {
      const o = Number(s.odds);
      if (o > 1 && o < short) { short = o; sel = s.sel; }
    }
    if (short <= 1.7) score = sel;
  }
  if (score !== "2:0" && score !== "2:1" && score !== "1:2" && score !== "0:2") return null;
  const homeSide = score === "2:0" || score === "2:1";
  const scoreRow = (g.scores || []).find((s) => s.sel === score);
  const winnerOdds = Number(homeSide ? g.win && g.win.home : g.win && g.win.away);
  const scoreOdds = Number(scoreRow && scoreRow.odds);
  return {
    score,
    winner: homeSide ? "1" : "2",
    winnerName: homeSide ? g.home : g.away,
    scoreOdds: scoreOdds > 1 ? scoreOdds : null,
    winnerOdds: winnerOdds > 1 ? winnerOdds : null,
  };
}

export async function trackBooks(games, opts = {}) {
  const { sql } = await import("./_db.js");
  await ensureCalls();
  await sql`DELETE FROM tn_calls`;
  for (const g of games || []) {
    const mark = bookMark(g);
    if (!mark) continue;
    await sql`
      INSERT INTO tn_books (
        event_id, home, away, tourn, start_at, score, winner, score_odds, winner_odds)
      VALUES (
        ${String(g.eventId)}, ${g.home || ""}, ${g.away || ""}, ${g.tourn || ""},
        ${Number(g.start) || null}, ${mark.score}, ${mark.winner},
        ${mark.scoreOdds}, ${mark.winnerOdds}
      )
      ON CONFLICT (event_id) DO NOTHING`;
  }
  const due = await sql`
    SELECT event_id, score, winner, result FROM tn_books
    WHERE start_at IS NOT NULL AND start_at < ${Date.now() - 20 * 60 * 1000}
      AND start_at > ${Date.now() - 36 * 60 * 60 * 1000}
      AND (result IS NULL OR score_hit IS NOT NULL)
    ORDER BY start_at ASC
    LIMIT 8`;
  if (opts.settle !== false && due.length) {
    const { fetchEvent } = await import("./_card.js");
    await pool(due.slice(0, 6), 6, async (row) => {
      const ev = await fetchEvent(row.event_id, { marketId: "186" });
      if (!ev) return;
      if (stillPlaying(ev)) {
        const hold = holdOf(ev);
        await sql`
          UPDATE tn_books
          SET result = NULL, score_hit = NULL, winner_hit = NULL, hold = ${hold || null}
          WHERE event_id = ${row.event_id}`;
        return;
      }
      const fin = finishedSets(ev);
      if (!fin || !/^\d+:\d+$/.test(String(fin.result || ""))) return;
      const [hs, as] = String(fin.result).split(":").map(Number);
      const scoreHit = fin.result === row.score;
      const winnerHit = row.winner === "1" ? hs > as : as > hs;
      await sql`
        UPDATE tn_books
        SET result = ${fin.result}, score_hit = ${scoreHit}, winner_hit = ${winnerHit}, hold = NULL
        WHERE event_id = ${row.event_id}`;
    });
  }
  const recent = await sql`
    SELECT event_id, home, away, tourn, start_at, score, winner, score_odds, winner_odds,
           result, score_hit, winner_hit, hold
    FROM tn_books ORDER BY start_at DESC NULLS LAST LIMIT 200`;
  return recent.map((r) => ({
    eventId: r.event_id,
    home: r.home,
    away: r.away,
    tourn: r.tourn || "",
    start: r.start_at ? Number(r.start_at) : null,
    score: r.score,
    winner: r.winner,
    scoreOdds: r.score_odds == null ? null : Number(r.score_odds),
    winnerOdds: r.winner_odds == null ? null : Number(r.winner_odds),
    result: r.result || null,
    hold: r.hold || "",
    scoreHit: r.score_hit == null ? null : r.score_hit === true,
    winnerHit: r.winner_hit == null ? null : r.winner_hit === true,
  }));
}

export async function trackTennis(games) {
  const { sql } = await import("./_db.js");
  await ensureCalls();
  await sql`DELETE FROM tn_calls`;
  applyRecord(games, { n: 0, hits: 0, open: 0, used: "early" });
  return { n: 0, hits: 0, open: 0, used: "early", rows: [] };
}
