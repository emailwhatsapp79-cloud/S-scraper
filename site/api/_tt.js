// Real table tennis off SportyBet (sr:sport:20). Own table, own pipeline.
// Win% is our own read — Elo + H2H + recent form off the banked pile — shrunk
// toward the book only while a pairing is thin on history. The fitted ratings
// are cached as a "pack" (tt_model) and refreshed on a timer, so the card loads
// fast instead of re-fitting tens of thousands of games on every request.
import { sql } from "./_db.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:20";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MARKET_IDS = "186";

let ready = false;
async function ensureTT() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS tt_games (
    match_id TEXT PRIMARY KEY,
    event_id TEXT,
    home TEXT, away TEXT,
    tourn TEXT,
    start_at BIGINT,
    status TEXT,
    win_home DOUBLE PRECISION,
    win_away DOUBLE PRECISION,
    cs_json TEXT,
    r_home INT, r_away INT,
    r_status TEXT,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  )`;
  ready = true;
}

async function getJson(path, params, timeoutMs = 7000) {
  const q = new URLSearchParams(params);
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/${path}?${q}`, {
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

function isUpcomingTT(status, start) {
  const st = String(status || "");
  if (/^(end|H1|H2|LIVE|1H|2H|Playing|Live)/i.test(st)) return false;
  if (start != null && Number(start) > 0 && Number(start) <= Date.now()) return false;
  return true;
}

function foldToken(t) {
  return t
    .replace(/SKYI$/g, "SKI")
    .replace(/SKIY$/g, "SKI")
    .replace(/SKII$/g, "SKI")
    .replace(/SKYJ$/g, "SKI")
    .replace(/YI$/g, "I")
    .replace(/IY$/g, "I");
}

function nameTokens(s) {
  return String(s || "")
    .toUpperCase()
    .replace(/[^A-Z]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map(foldToken);
}

function nameKey(s) {
  // "Vorsulyak, Yaroslav" == "Yaroslav Vorsulyak"
  // Drop single-letter initials so "Krejci, R" still meets "Richard Krejci".
  return nameTokens(s).sort().join("|");
}

function scoreKey(desc) {
  const m = String(desc || "").match(/(\d+)\s*[:\-]\s*(\d+)/);
  return m ? m[1] + ":" + m[2] : null;
}

function parseMarkets(ev, home, away) {
  const win = {}, cs = {};
  const markets = ev?.markets || ev?.playList || [];
  for (const m of markets) {
    const desc = String(m.desc || m.name || "").toLowerCase();
    const outs = m.outcomes || m.ops || [];
    const winner = desc === "winner" || desc === "match winner" || desc === "moneyline";
    const correct = desc.includes("correct score") || desc.includes("set betting") || desc.includes("correct set");
    if (winner) {
      for (const o of outs) {
        const p = parseFloat(o.odds);
        if (!isFinite(p)) continue;
        const d = String(o.desc || o.name || "");
        const id = String(o.id || o.outcomeId || o.oid || "");
        if (/^home$/i.test(d) || d === home || id === "1" || id === "4") win.Home = p;
        else if (/^away$/i.test(d) || d === away || id === "2" || id === "5") win.Away = p;
      }
    } else if (correct) {
      for (const o of outs) {
        const p = parseFloat(o.odds);
        const k = scoreKey(o.desc || o.name);
        if (k && isFinite(p)) cs[k] = p;
      }
    }
  }
  return { win, cs };
}

export async function fetchTTCard() {
  const found = [];
  const seen = new Set();
  const errors = [];
  try {
    for (let page = 1; page <= 6; page++) {
      const data = await getJson("pcUpcomingEvents", {
        sportId: SPORT, marketId: MARKET_IDS, option: "1",
        pageSize: "100", pageNum: String(page),
      });
      let count = 0;
      for (const t of data?.tournaments || []) {
        const tourn = t.name || "";
        for (const ev of t.events || []) {
          count++;
          if (!ev?.gameId || !ev.homeTeamName || !ev.awayTeamName) continue;
          const id = String(ev.gameId);
          if (seen.has(id)) continue;
          seen.add(id);
          found.push({ ...ev, _tourn: tourn });
        }
      }
      if (count < 100) break;
    }
  } catch (e) {
    errors.push(String(e?.message || e));
  }
  return { events: found, errors };
}

export function normalise(ev) {
  const home = ev.homeTeamName || "?";
  const away = ev.awayTeamName || "?";
  const { win, cs } = parseMarkets(ev, home, away);
  return {
    id: String(ev.gameId),
    eventId: ev.eventId || null,
    home, away,
    tourn: ev._tourn || (ev.sport?.category?.tournament?.name) || "",
    start: ev.estimateStartTime ? Number(ev.estimateStartTime) : null,
    status: ev.matchStatus || "",
    win: (win.Home != null || win.Away != null) ? { home: win.Home, away: win.Away } : null,
    cs: Object.keys(cs).length ? cs : null,
  };
}

export async function storeTT(games) {
  await ensureTT();
  if (!games.length) return 0;
  const jobs = games.map((g) => {
    const cs = g.cs && Object.keys(g.cs).length ? JSON.stringify(g.cs) : null;
    return sql`
      INSERT INTO tt_games (
        match_id, event_id, home, away, tourn, start_at, status,
        win_home, win_away, cs_json
      )
      VALUES (
        ${g.id}, ${g.eventId}, ${g.home}, ${g.away}, ${g.tourn}, ${g.start}, ${g.status},
        ${g.win?.home ?? null}, ${g.win?.away ?? null}, ${cs}
      )
      ON CONFLICT (match_id) DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, tt_games.event_id),
        tourn = COALESCE(NULLIF(EXCLUDED.tourn, ''), tt_games.tourn),
        start_at = COALESCE(EXCLUDED.start_at, tt_games.start_at),
        status = EXCLUDED.status,
        win_home = COALESCE(EXCLUDED.win_home, tt_games.win_home),
        win_away = COALESCE(EXCLUDED.win_away, tt_games.win_away),
        cs_json = COALESCE(EXCLUDED.cs_json, tt_games.cs_json),
        last_seen = now()`;
  });
  await Promise.all(jobs);
  return games.length;
}

function csFrom(markets) {
  return parseMarkets({ markets }, null, null);
}

function parseSet(s) {
  const m = String(s || "").trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

async function fetchEvent(eventId) {
  if (!eventId) return null;
  try { return await getJson("event", { eventId, productId: "3" }); }
  catch { return null; }
}

export async function enrichSettleTT(limit = 80) {
  await ensureTT();
  const now = Date.now();
  const due = await sql`
    SELECT match_id, event_id, start_at, r_status, win_home, cs_json, home, away
    FROM tt_games
    WHERE event_id IS NOT NULL
      AND start_at IS NOT NULL
      AND (
        (r_status IS NULL AND start_at < ${now - 90000})
        OR (win_home IS NULL AND start_at > ${now - 90000})
        OR (cs_json IS NULL AND start_at > ${now - 90000})
      )
    ORDER BY start_at ASC
    LIMIT ${limit}`;
  if (!due.length) return { touched: 0 };
  const evs = await Promise.all(due.map((r) => fetchEvent(r.event_id)));
  let touched = 0;
  for (let i = 0; i < due.length; i++) {
    const ev = evs[i];
    if (!ev) continue;
    const { win, cs } = parseMarkets(ev, due[i].home, due[i].away);
    const status = ev.matchStatus || "";
    const ended = /^end/i.test(status);
    const score = ended ? parseSet(ev.setScore) : null;
    await sql`
      UPDATE tt_games SET
        win_home = COALESCE(${win.Home ?? null}, win_home),
        win_away = COALESCE(${win.Away ?? null}, win_away),
        cs_json = COALESCE(${Object.keys(cs).length ? JSON.stringify(cs) : null}, cs_json),
        status = COALESCE(${status || null}, status),
        r_home = COALESCE(${score ? score.home : null}, r_home),
        r_away = COALESCE(${score ? score.away : null}, r_away),
        r_status = COALESCE(${ended ? "ended" : null}, r_status),
        settled_at = COALESCE(${ended ? new Date().toISOString() : null}, settled_at)
      WHERE match_id = ${due[i].match_id}`;
    touched++;
  }
  return { touched };
}

export function winPctBook(hOdds, aOdds) {
  const h = Number(hOdds), a = Number(aOdds);
  if (!isFinite(h) || !isFinite(a) || h <= 0 || a <= 0) return null;
  const ih = 1 / h, ia = 1 / a, s = ih + ia;
  if (s <= 0) return null;
  return { home: ih / s, away: ia / s };
}

function tournKey(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/\d+$/, "");
}

// 3–0 wipe = 3, 3–1 = 2, 3–2 close = 1. This is the "strong hand" read:
// 3–3 in matches is not 50/50 if one player keeps winning 3–0.
function patternPts(wonSets, lostSets) {
  const w = Number(wonSets), l = Number(lostSets);
  if (!isFinite(w) || !isFinite(l) || w + l <= 0) return 0;
  if (l === 0) return 3;
  if (w - l <= 1) return 1;
  return 2;
}

function emptyH2H() {
  return { n: 0, hw: 0, hs: 0, as: 0, hW3: 0, hW2: 0, hW1: 0, aW3: 0, aW2: 0, aW1: 0 };
}

function bumpPattern(row, homeWon, pts) {
  if (pts === 3) { if (homeWon) row.hW3++; else row.aW3++; }
  else if (pts === 2) { if (homeWon) row.hW2++; else row.aW2++; }
  else if (pts === 1) { if (homeWon) row.hW1++; else row.aW1++; }
}

function formVsField(rec, excludeKey) {
  const list = (rec || []).filter((x) => x.vs !== excludeKey).slice(-50);
  if (list.length < 3) return null;
  const w = list.filter((x) => x.won).length;
  let sw = 0, sl = 0, straight = 0, mid = 0, close = 0, pts = 0, opp = 0;
  for (const x of list) {
    const a = Number(x.sw), b = Number(x.sl);
    if (isFinite(a) && isFinite(b)) {
      sw += a; sl += b;
      const p = patternPts(a, b);
      if (x.won) {
        pts += p;
        if (p === 3) straight++;
        else if (p === 2) mid++;
        else close++;
      } else {
        opp += p;
      }
    }
  }
  const p = (pts + opp) >= 4
    ? (pts + 2) / (pts + opp + 4)
    : (w + 2) / (list.length + 4);
  return { n: list.length, w, l: list.length - w, sw, sl, straight, mid, close, pts, p };
}

function findPlayer(players, name, blank) {
  const k = nameKey(name);
  if (players[k]) return { rec: players[k], key: k };
  const toks = k.split("|").filter(Boolean);
  if (!toks.length) return { rec: blank, key: k };
  const hits = Object.keys(players).filter((pk) => {
    const set = new Set(pk.split("|"));
    return toks.every((t) => set.has(t));
  });
  if (hits.length === 1) return { rec: players[hits[0]], key: hits[0] };
  const long = toks.filter((t) => t.length >= 4);
  if (long.length) {
    const byLast = Object.keys(players).filter((pk) => long.every((t) => pk.split("|").includes(t)));
    if (byLast.length === 1) return { rec: players[byLast[0]], key: byLast[0] };
  }
  return { rec: blank, key: k };
}

function combinedH2H(h2h, keyH, keyA) {
  const a = keyH, b = keyA;
  const ab = h2h[a + ">" + b] || emptyH2H();
  const ba = h2h[b + ">" + a] || emptyH2H();
  const n = ab.n + ba.n;
  const homeWins = ab.hw + (ba.n - ba.hw);
  const setsH = (ab.hs || 0) + (ba.as || 0);
  const setsA = (ab.as || 0) + (ba.hs || 0);
  const hW3 = (ab.hW3 || 0) + (ba.aW3 || 0);
  const hW2 = (ab.hW2 || 0) + (ba.aW2 || 0);
  const hW1 = (ab.hW1 || 0) + (ba.aW1 || 0);
  const aW3 = (ab.aW3 || 0) + (ba.hW3 || 0);
  const aW2 = (ab.aW2 || 0) + (ba.hW2 || 0);
  const aW1 = (ab.aW1 || 0) + (ba.hW1 || 0);
  const hPts = 3 * hW3 + 2 * hW2 + 1 * hW1;
  const aPts = 3 * aW3 + 2 * aW2 + 1 * aW1;
  return {
    n, home: homeWins, away: n - homeWins, setsH, setsA,
    hW3, hW2, hW1, aW3, aW2, aW1, hPts, aPts,
  };
}

export function forecastTT(pack, g) {
  const blank = { n: 0, elo: 1500, rec: [], last: 0, tourn: {} };
  const foundH = findPlayer(pack.players || {}, g.home, blank);
  const foundA = findPlayer(pack.players || {}, g.away, blank);
  const H = foundH.rec, A = foundA.rec;
  const parts = [];

  const thin = Math.min(H.n || 0, A.n || 0) < 8;
  parts.push({
    p: 1 / (1 + 10 ** (((A.elo || 1500) - (H.elo || 1500)) / 400)),
    w: thin ? 0.2 : 0.8,
  });

  const h2hRec = combinedH2H(pack.h2h || {}, foundH.key, foundA.key);
  if (h2hRec.n >= 1) {
    const sets = (h2hRec.setsH || 0) + (h2hRec.setsA || 0);
    const pat = (h2hRec.hPts || 0) + (h2hRec.aPts || 0);
    let hp;
    if (pat >= 2) hp = (h2hRec.hPts + 1) / (pat + 2);
    else if (sets >= 4) hp = (h2hRec.setsH + 1) / (sets + 2);
    else hp = (h2hRec.home + 1) / (h2hRec.n + 2);
    parts.push({ p: hp, w: 1.5 + Math.min(5, h2hRec.n) });
  }

  const formH = formVsField(H.rec, foundA.key);
  const formA = formVsField(A.rec, foundH.key);
  if (formH && formA && formH.p + formA.p > 0) {
    parts.push({ p: formH.p / (formH.p + formA.p), w: 0.9 });
  }

  const T = tournKey(g.tourn);
  if (T) {
    const ht = H.tourn[T], at = A.tourn[T];
    if (ht && at && ht.n >= 3 && at.n >= 3) {
      const ph = (ht.w + 1) / (ht.n + 2);
      const pa = (at.w + 1) / (at.n + 2);
      if (ph + pa > 0) parts.push({ p: ph / (ph + pa), w: 0.4 });
    }
  }

  const sw = parts.reduce((s, x) => s + x.w, 0);
  let p = sw ? parts.reduce((s, x) => s + x.p * x.w, 0) / sw : 0.5;
  p += pack.ha || 0;
  if (g.start && H.last && g.start - H.last < 2 * 3600 * 1000) p -= 0.03;
  if (g.start && A.last && g.start - A.last < 2 * 3600 * 1000) p += 0.03;
  p = Math.min(0.92, Math.max(0.08, p));

  return {
    pHome: p, pAway: 1 - p,
    nH: H.n, nA: A.n,
    h2hRec, formH, formA,
  };
}

export function fitTT(games, into) {
  const players = into?.players || {};
  const h2h = into?.h2h || {};
  let homeN = into?.homeN || 0, homeW = into?.homeW || 0;
  const P = (name) => {
    const k = nameKey(name);
    return players[k] || (players[k] = { n: 0, w: 0, elo: 1500, last: 0, rec: [], tourn: {} });
  };
  const bt = into?.bt || { n: 0, hit: 0, brier: 0, bins: Array.from({ length: 5 }, () => ({ n: 0, w: 0 })) };
  const settled = (games || [])
    .filter((g) => g.res && g.res.home != null && g.res.away != null)
    .sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const g of settled) {
    const hw = g.res.home > g.res.away;
    const H = P(g.home), A = P(g.away);
    const need = Math.max(g.res.home, g.res.away) || 3;
    const margin = Math.abs(g.res.home - g.res.away) / need;
    const exp = 1 / (1 + 10 ** ((A.elo - H.elo) / 400));
    if (H.n >= 5 && A.n >= 5) {
      const y = hw ? 1 : 0;
      bt.n++;
      bt.brier += (exp - y) * (exp - y);
      const rightSide = (exp >= 0.5) === (y === 1);
      if (rightSide) bt.hit++;
      const conf = Math.max(exp, 1 - exp);
      const bi = Math.min(4, Math.max(0, Math.floor((conf - 0.5) / 0.1)));
      bt.bins[bi].n++;
      if (rightSide) bt.bins[bi].w++;
    }
    const k = 12 + 20 * margin;
    H.elo += k * ((hw ? 1 : 0) - exp);
    A.elo += k * ((hw ? 0 : 1) - (1 - exp));
    H.n++; A.n++;
    if (hw) H.w++; else A.w++;
    homeN++; if (hw) homeW++;
    H.last = g.start || 0; A.last = g.start || 0;
    H.rec.push({ t: g.start || 0, won: hw, vs: nameKey(g.away), sw: g.res.home, sl: g.res.away });
    A.rec.push({ t: g.start || 0, won: !hw, vs: nameKey(g.home), sw: g.res.away, sl: g.res.home });
    if (H.rec.length > 80) H.rec.shift();
    if (A.rec.length > 80) A.rec.shift();
    const T = tournKey(g.tourn);
    if (T) {
      const ht = H.tourn[T] || (H.tourn[T] = { n: 0, w: 0 });
      const at = A.tourn[T] || (A.tourn[T] = { n: 0, w: 0 });
      ht.n++; at.n++;
      if (hw) ht.w++; else at.w++;
    }
    const hk = nameKey(g.home) + ">" + nameKey(g.away);
    const row = h2h[hk] || (h2h[hk] = emptyH2H());
    row.n++;
    if (hw) row.hw++;
    row.hs += Number(g.res.home) || 0;
    row.as += Number(g.res.away) || 0;
    bumpPattern(row, hw, patternPts(
      hw ? g.res.home : g.res.away,
      hw ? g.res.away : g.res.home
    ));
  }
  const ha = homeN >= 30 ? Math.min(0.08, Math.max(-0.08, homeW / homeN - 0.5)) : 0;
  const backtest = {
    n: bt.n,
    hit: bt.n ? bt.hit / bt.n : null,
    brier: bt.n ? bt.brier / bt.n : null,
    // "when we call it 70%+, how often are we right" — the confident buckets
    strongN: bt.bins.slice(2).reduce((s, b) => s + b.n, 0),
    strongHit: (() => {
      const n = bt.bins.slice(2).reduce((s, b) => s + b.n, 0);
      const w = bt.bins.slice(2).reduce((s, b) => s + b.w, 0);
      return n ? w / n : null;
    })(),
  };
  return { players, h2h, ha, homeN, homeW, bt, backtest };
}

function shape(r) {
  let cs = null;
  if (r.cs_json) { try { cs = JSON.parse(r.cs_json); } catch { cs = null; } }
  const start = r.start_at ? Number(r.start_at) : null;
  const win = (r.win_home != null || r.win_away != null) ? { home: r.win_home, away: r.win_away } : null;
  return {
    id: r.match_id, eventId: r.event_id || null,
    home: r.home, away: r.away, tourn: r.tourn || "",
    start, status: r.status || "",
    upcoming: isUpcomingTT(r.status, start),
    win, cs,
    res: r.r_home == null ? null : { home: r.r_home, away: r.r_away },
  };
}

function rowsToGames(rows) {
  const seen = new Map();
  for (const r of rows) {
    const g = {
      id: r.match_id,
      home: r.home, away: r.away, tourn: r.tourn || "",
      start: r.start_at ? Number(r.start_at) : 0,
      res: { home: r.r_home, away: r.r_away },
    };
    const pair = [nameKey(g.home), nameKey(g.away)].sort().join("|");
    const k = pair + "|" + Math.round((g.start || 0) / 900000);
    const prev = seen.get(k);
    if (!prev) seen.set(k, g);
    else if (!/^(sofa:|s24:)/.test(String(g.id || ""))) seen.set(k, g);
  }
  return [...seen.values()].sort((a, b) => (a.start || 0) - (b.start || 0));
}

async function loadSettledSlice(afterStart, afterId, limit) {
  await ensureTT();
  const rows = await sql`
    SELECT match_id, home, away, tourn, start_at, r_home, r_away
    FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL AND start_at IS NOT NULL
      AND (start_at > ${afterStart} OR (start_at = ${afterStart} AND match_id > ${afterId}))
    ORDER BY start_at ASC, match_id ASC
    LIMIT ${limit}`;
  const last = rows.length ? rows[rows.length - 1] : null;
  return {
    games: rowsToGames(rows),
    afterStart: last ? Number(last.start_at) : afterStart,
    afterId: last ? String(last.match_id) : afterId,
    more: rows.length >= limit,
  };
}

async function loadNewlySettled(sinceIso, limit) {
  if (!sinceIso) return [];
  const rows = await sql`
    SELECT match_id, home, away, tourn, start_at, r_home, r_away
    FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL
      AND settled_at > ${sinceIso}
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  return rowsToGames(rows);
}

async function loadSettledForFit() {
  const all = [];
  let afterStart = 0, afterId = "";
  for (let i = 0; i < 20; i++) {
    const part = await loadSettledSlice(afterStart, afterId, 12000);
    all.push(...part.games);
    afterStart = part.afterStart; afterId = part.afterId;
    if (!part.more) break;
  }
  return all.sort((a, b) => (a.start || 0) - (b.start || 0));
}

function attachForecast(games, pack) {
  for (const g of games) {
    const f = forecastTT(pack, g);
    const book = g.win ? winPctBook(g.win.home, g.win.away) : null;
    const h2hN = f.h2hRec ? f.h2hRec.n : 0;
    const hasForm = !!(f.formH && f.formA);
    const evidence = (f.nH || 0) + (f.nA || 0) + 3 * h2hN + (hasForm ? 6 : 0);
    // Our number is the model only. SportyBet's price is shown beside it, never mixed in.
    const pHome = Math.min(0.97, Math.max(0.03, f.pHome));
    const ours = { home: Math.round(pHome * 100), away: Math.round((1 - pHome) * 100) };
    g.pct = evidence >= 1 ? ours : null;
    g.ours = evidence >= 1 ? ours : null;
    g.book = book ? { home: Math.round(book.home * 100), away: Math.round(book.away * 100) } : null;
    g.nH = f.nH; g.nA = f.nA;
    g.h2hRec = f.h2hRec || emptyH2H();
    g.formH = f.formH; g.formA = f.formA;
  }
  return games;
}

// ── Ratings pack cache ──────────────────────────────────────────────────────
// Fitting tens of thousands of games on every card load was too slow. Instead
// we fit once, stash the pack in tt_model, and rebuild it only when it goes
// stale. Input is the most recent 50k settled games.
const PACK_STALE_MS = 90 * 1000;
const EMPTY_PACK = { players: {}, h2h: {}, ha: 0, nGames: 0, backtest: null };
let _pack = null;         // { builtAt, data }
let _packTable = false;

async function ensurePackTable() {
  if (_packTable) return;
  await sql`CREATE TABLE IF NOT EXISTS tt_model (
    k TEXT PRIMARY KEY,
    pack TEXT,
    built_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  _packTable = true;
}

// Keep only what forecastTT reads, and cap each player's history, so the stored
// JSON stays a few MB rather than tens.
function trimPack(raw) {
  const players = {};
  for (const [k, p] of Object.entries(raw.players)) {
    players[k] = {
      n: p.n, w: p.w, last: p.last,
      elo: Math.round(p.elo * 10) / 10,
      rec: (p.rec || []).slice(-50).map((x) => ({ won: x.won, vs: x.vs, sw: x.sw, sl: x.sl })),
      tourn: p.tourn,
    };
  }
  return {
    players, h2h: raw.h2h, ha: raw.ha,
    nGames: raw.homeN || 0,
    backtest: raw.backtest || null,
  };
}

async function buildAndSavePack() {
  await ensurePackTable();
  let into = null, afterStart = 0, afterId = "";
  try {
    const st = await sql`SELECT pack FROM tt_model WHERE k = ${"fit"}`;
    if (st[0] && st[0].pack) {
      const s = JSON.parse(st[0].pack);
      afterStart = Number(s.afterStart) || 0;
      afterId = String(s.afterId || "");
      into = {
        players: s.players || {},
        h2h: s.h2h || {},
        homeN: s.homeN || 0,
        homeW: s.homeW || 0,
        bt: s.bt || null,
      };
    }
  } catch { into = null; }

  const slice = await loadSettledSlice(afterStart, afterId, 22000);
  if (slice.games.length) {
    const raw = fitTT(slice.games, into);
    return await persistPack(raw, slice);
  }
  // Cursor is caught up. Still fold in games that *settled* after last train —
  // live matches that just got a score, start_at is in the past so the cursor
  // would skip them forever.
  let lastBuilt = null;
  try {
    const meta = await sql`SELECT built_at FROM tt_model WHERE k = 'pack'`;
    lastBuilt = meta[0] && meta[0].built_at ? new Date(meta[0].built_at).toISOString() : null;
  } catch { lastBuilt = null; }
  const fresh = await loadNewlySettled(lastBuilt, 8000);
  if (fresh.length) {
    const raw = fitTT(fresh, into);
    return await persistPack(raw, { afterStart, afterId, more: false });
  }
  const cur = await ensureModelPack();
  if (cur && cur.nGames) { cur.more = false; return cur; }
  return EMPTY_PACK;
}

async function persistPack(raw, slice) {
  const data = trimPack(raw);
  const iso = new Date().toISOString();
  data.builtAt = iso;
  data.more = !!slice.more;
  const json = JSON.stringify(data);
  const fit = JSON.stringify({
    afterStart: slice.afterStart,
    afterId: slice.afterId,
    more: !!slice.more,
    players: data.players,
    h2h: data.h2h,
    homeN: raw.homeN,
    homeW: raw.homeW,
    bt: raw.bt,
  });
  await sql`
    INSERT INTO tt_model (k, pack, built_at) VALUES ('pack', ${json}, ${iso})
    ON CONFLICT (k) DO UPDATE SET pack = ${json}, built_at = ${iso}`;
  await sql`
    INSERT INTO tt_model (k, pack, built_at) VALUES (${"fit"}, ${fit}, ${iso})
    ON CONFLICT (k) DO UPDATE SET pack = ${fit}, built_at = ${iso}`;
  _pack = { builtAt: iso, data };
  return data;
}

// Return the stored pack. Never fit on a card load — that is what made TT hang.
// A cheap built_at check keeps a warm instance from serving a frozen copy after
// another instance (or the poll) has rebuilt the pack.
async function ensureModelPack() {
  await ensurePackTable();
  let builtAt = null;
  try {
    const meta = await sql`SELECT built_at FROM tt_model WHERE k = 'pack'`;
    builtAt = meta[0] && meta[0].built_at ? new Date(meta[0].built_at).toISOString() : null;
  } catch { builtAt = null; }
  if (_pack && _pack.data && (!builtAt || _pack.builtAt === builtAt)) return _pack.data;
  let full = [];
  try { full = await sql`SELECT pack, built_at FROM tt_model WHERE k = 'pack'`; } catch { full = []; }
  if (!full[0] || !full[0].pack) return (_pack && _pack.data) || EMPTY_PACK;
  try {
    const data = JSON.parse(full[0].pack);
    _pack = { builtAt: new Date(full[0].built_at).toISOString(), data };
    return data;
  } catch {
    return (_pack && _pack.data) || EMPTY_PACK;
  }
}

// Poll/cron can force a refresh so the pack stays warm even with no visitors.
// rebuildPack now drives the online trainer (each call trains the next chunk of
// untrained games). Name kept so the poll/fill wiring doesn't have to change.
export async function rebuildPack() {
  try {
    const { trainBatch } = await import("./_ratings.js");
    return await trainBatch(2500, 12000);
  } catch (e) { return { error: String(e?.message || e) }; }
}

export async function getModelMeta() {
  try {
    const { ratingsMeta } = await import("./_ratings.js");
    return await ratingsMeta();
  } catch { return null; }
}

export async function listUpcomingTT(limit = 400) {
  await ensureTT();
  const cutoff = Date.now() - 2 * 60 * 1000;
  const rows = await sql`
    SELECT * FROM tt_games
    WHERE start_at > ${cutoff}
      AND match_id NOT LIKE ${"s24:%"}
      AND match_id NOT LIKE ${"sofa:%"}
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  const games = rows.map(shape).filter((g) => g.upcoming);
  // Score the card off the online rating store (per-player, no big pack). Fall
  // back to the legacy pack only if the store errors, so the card never breaks.
  try {
    const { forecastCard } = await import("./_ratings.js");
    return await forecastCard(games);
  } catch {
    let pack;
    try { pack = await ensureModelPack(); } catch { pack = EMPTY_PACK; }
    return attachForecast(games, pack);
  }
}

// Recently PLAYED matches from anywhere in the pile (SportyBet or the history
// feed), newest match first — so "they've been playing" actually shows.
export async function listRecentResultsTT(limit = 60) {
  await ensureTT();
  const rows = await sql`
    SELECT * FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL
      AND start_at IS NOT NULL
    ORDER BY start_at DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map(shape);
}

export async function countsTT() {
  await ensureTT();
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE r_home IS NOT NULL AND r_away IS NOT NULL) AS settled
    FROM tt_games`;
  const r = rows[0] || {};
  return { total: Number(r.total || 0), settled: Number(r.settled || 0) };
}
