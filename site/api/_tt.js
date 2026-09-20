// Real table tennis off SportyBet (sr:sport:20). Own table, own pipeline.
// Win% is Elo + H2H + recent form, shrunk toward the book only when the
// pile is thin. Correct score % comes from the same match probability
// (set-win model), not from 1/odd.
import { sql } from "./_db.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:20";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const MARKET_IDS = "1";

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

async function getJson(path, params) {
  const q = new URLSearchParams(params);
  const r = await fetch(`${BASE}/${path}?${q}`, {
    headers: { "User-Agent": UA, Accept: "application/json" },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const body = await r.json();
  if (body.bizCode !== 10000) throw new Error(`bizCode ${body.bizCode}`);
  return body.data;
}

function isUpcomingTT(status, start) {
  const st = String(status || "");
  if (/^(end|H1|H2|LIVE|1H|2H|Playing|Live)/i.test(st)) return false;
  if (start != null && Number(start) > 0 && Number(start) <= Date.now()) return false;
  return true;
}

function nameKey(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
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
        if (/^home$/i.test(d) || d === home || id === "1") win.Home = p;
        else if (/^away$/i.test(d) || d === away || id === "2") win.Away = p;
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
    SELECT match_id, event_id, start_at, r_status, win_home, cs_json
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
    const { win, cs } = parseMarkets(ev, null, null);
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

function winPctBook(hOdds, aOdds) {
  const h = Number(hOdds), a = Number(aOdds);
  if (!isFinite(h) || !isFinite(a) || h <= 0 || a <= 0) return null;
  const ih = 1 / h, ia = 1 / a, s = ih + ia;
  if (s <= 0) return null;
  return { home: ih / s, away: ia / s };
}

function binom(n, k) {
  if (k < 0 || k > n) return 0;
  k = Math.min(k, n - k);
  let r = 1;
  for (let i = 1; i <= k; i++) r = r * (n - k + i) / i;
  return r;
}

function pMatchFromSet(ps, need) {
  const q = 1 - ps;
  let s = 0;
  for (let k = 0; k < need; k++) {
    s += binom(need - 1 + k, k) * Math.pow(ps, need) * Math.pow(q, k);
  }
  return s;
}

function matchToSet(pMatch, need) {
  let lo = 0.05, hi = 0.95;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (pMatchFromSet(mid, need) < pMatch) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

function setScores(ps, need) {
  const q = 1 - ps;
  const out = {};
  for (let k = 0; k < need; k++) {
    out[need + ":" + k] = binom(need - 1 + k, k) * Math.pow(ps, need) * Math.pow(q, k);
    out[k + ":" + need] = binom(need - 1 + k, k) * Math.pow(q, need) * Math.pow(ps, k);
  }
  return out;
}

function detectBO(cs) {
  if (cs) {
    for (const k of Object.keys(cs)) {
      const [a, b] = k.split(":").map(Number);
      if (a === 4 || b === 4) return 4;
    }
  }
  return 3;
}

function formVsField(rec, excludeKey) {
  const list = (rec || []).filter((x) => x.vs !== excludeKey).slice(-20);
  if (list.length < 3) return null;
  const w = list.filter((x) => x.won).length;
  return { n: list.length, w, l: list.length - w, p: (w + 2) / (list.length + 4) };
}

function combinedH2H(h2h, home, away) {
  const a = nameKey(home), b = nameKey(away);
  const ab = h2h[a + ">" + b] || { n: 0, hw: 0 };
  const ba = h2h[b + ">" + a] || { n: 0, hw: 0 };
  const n = ab.n + ba.n;
  const homeWins = ab.hw + (ba.n - ba.hw);
  return { n, home: homeWins, away: n - homeWins };
}

export function forecastTT(pack, g) {
  const blank = { n: 0, elo: 1500, rec: [], last: 0, tourn: {} };
  const H = pack.players[nameKey(g.home)] || blank;
  const A = pack.players[nameKey(g.away)] || blank;
  const parts = [];
  parts.push(1 / (1 + 10 ** ((A.elo - H.elo) / 400)));

  const h2hRec = combinedH2H(pack.h2h || {}, g.home, g.away);
  if (h2hRec.n >= 2) parts.push((h2hRec.home + 1) / (h2hRec.n + 2));

  const formH = formVsField(H.rec, nameKey(g.away));
  const formA = formVsField(A.rec, nameKey(g.home));
  if (formH && formA && formH.p + formA.p > 0) parts.push(formH.p / (formH.p + formA.p));

  const T = String(g.tourn || "").trim();
  if (T) {
    const ht = H.tourn[T], at = A.tourn[T];
    if (ht && at && ht.n >= 3 && at.n >= 3) {
      const ph = (ht.w + 1) / (ht.n + 2);
      const pa = (at.w + 1) / (at.n + 2);
      if (ph + pa > 0) parts.push(ph / (ph + pa));
    }
  }

  let p = parts.reduce((s, x) => s + x, 0) / parts.length;
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

export function fitTT(games) {
  const players = {};
  const h2h = {};
  let homeN = 0, homeW = 0;
  const P = (name) => {
    const k = nameKey(name);
    return players[k] || (players[k] = { n: 0, w: 0, elo: 1500, last: 0, rec: [], tourn: {} });
  };
  const settled = (games || [])
    .filter((g) => g.res && g.res.home != null && g.res.away != null)
    .sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const g of settled) {
    const hw = g.res.home > g.res.away;
    const H = P(g.home), A = P(g.away);
    const need = Math.max(g.res.home, g.res.away) || 3;
    const margin = Math.abs(g.res.home - g.res.away) / need;
    const exp = 1 / (1 + 10 ** ((A.elo - H.elo) / 400));
    const k = 12 + 20 * margin;
    H.elo += k * ((hw ? 1 : 0) - exp);
    A.elo += k * ((hw ? 0 : 1) - (1 - exp));
    H.n++; A.n++;
    if (hw) H.w++; else A.w++;
    homeN++; if (hw) homeW++;
    H.last = g.start || 0; A.last = g.start || 0;
    H.rec.push({ t: g.start || 0, won: hw, vs: nameKey(g.away) });
    A.rec.push({ t: g.start || 0, won: !hw, vs: nameKey(g.home) });
    if (H.rec.length > 20) H.rec.shift();
    if (A.rec.length > 20) A.rec.shift();
    const T = String(g.tourn || "").trim();
    if (T) {
      const ht = H.tourn[T] || (H.tourn[T] = { n: 0, w: 0 });
      const at = A.tourn[T] || (A.tourn[T] = { n: 0, w: 0 });
      ht.n++; at.n++;
      if (hw) ht.w++; else at.w++;
    }
    const hk = nameKey(g.home) + ">" + nameKey(g.away);
    const row = h2h[hk] || (h2h[hk] = { n: 0, hw: 0 });
    row.n++;
    if (hw) row.hw++;
  }
  const ha = homeN >= 30 ? Math.min(0.08, Math.max(-0.08, homeW / homeN - 0.5)) : 0;
  return { players, h2h, ha, homeN };
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

async function loadSettledForFit() {
  await ensureTT();
  const rows = await sql`
    SELECT home, away, tourn, start_at, r_home, r_away
    FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL
    ORDER BY start_at ASC NULLS LAST
    LIMIT 4000`;
  return rows.map((r) => ({
    home: r.home, away: r.away, tourn: r.tourn || "",
    start: r.start_at ? Number(r.start_at) : 0,
    res: { home: r.r_home, away: r.r_away },
  }));
}

function attachForecast(games, pack) {
  for (const g of games) {
    const f = forecastTT(pack, g);
    g.pct = { home: Math.round(f.pHome * 100), away: Math.round(f.pAway * 100) };
    g.nH = f.nH; g.nA = f.nA;
    g.h2hRec = f.h2hRec || { n: 0, home: 0, away: 0 };
    g.formH = f.formH; g.formA = f.formA;
  }
  return games;
}

export async function listUpcomingTT(limit = 400) {
  await ensureTT();
  const cutoff = Date.now() - 2 * 60 * 1000;
  const rows = await sql`
    SELECT * FROM tt_games
    WHERE start_at IS NULL OR start_at > ${cutoff}
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  const games = rows.map(shape).filter((g) => g.upcoming);
  const pack = fitTT(await loadSettledForFit());
  return attachForecast(games, pack);
}

export async function listRecentResultsTT(limit = 60) {
  await ensureTT();
  const rows = await sql`
    SELECT * FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL
    ORDER BY COALESCE(settled_at, to_timestamp(start_at / 1000)) DESC NULLS LAST,
             start_at DESC NULLS LAST
    LIMIT ${limit}`;
  return rows.map(shape);
}

export async function countsTT() {
  await ensureTT();
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE r_status IS NOT NULL) AS settled
    FROM tt_games`;
  const r = rows[0] || {};
  return { total: Number(r.total || 0), settled: Number(r.settled || 0) };
}
