// Tennis stats model — player numbers only, never the price, like table
// tennis' statsHome. Inputs: rating gap (Elo, K shrinking with matches
// played), last-20 win share, last-10 share of games won, head-to-head,
// rest and career record, combined by a logistic fit on SportyBet's own
// results (weights in TN_W, fitted offline on the older 70%, tested on the
// newest 30%). Each finished match is learned once, oldest first, and the
// % it would have shown is written down first (pre_stats) for the record.
import { sql } from "./_db.js";
import { ensureTnHist } from "./_tn_hist.js";

// Fitted 10 Oct 2026 on 11k matches, tested on the newest 4,725: 70-75% won
// 75%, 75-80% won 80%, 80-90% won 85%, 90%+ won 98%.
export const TN_W = { b: 0.0445, elo: 0.8936, form: -2.1405, gs: 2.2261, h2h: 2.3314, rest: 0.0877, career: 0.0579 };
export const MIN_N = 10;

export function tnKey(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase()
    .replace(/[^A-Z]+/g, " ").trim().split(/\s+/).filter((t) => t.length > 1).sort().join("|");
}

const kOf = (n) => 250 / Math.pow((n || 0) + 5, 0.4);
const mean = (a) => (a && a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0.5);
const careerLogit = (p) => { const c = ((p.w || 0) + 1) / ((p.n || 0) + 2); return Math.log(c / (1 - c)); };
const restOf = (p, t) => Math.log1p(p.last ? Math.min(Math.max(0, (t - p.last) / 86400000), 30) : 30);

export function gamesShare(games, home) {
  let a = 0, b = 0;
  for (const g of String(games || "").split(/\s+/)) {
    const m = g.match(/^(\d+):(\d+)$/);
    if (m) { a += Number(m[1]); b += Number(m[2]); }
  }
  if (!(a + b)) return 0.5;
  return home ? a / (a + b) : b / (a + b);
}

/** Home win chance from the two players' rows and their meeting record. */
export function statsTennis(H, A, h2h, start) {
  if (!H || !A || (H.n || 0) < MIN_N || (A.n || 0) < MIN_N) return null;
  const t = Number(start) || Date.now();
  const hn = h2h ? h2h.n : 0, hw = h2h ? h2h.hw : 0;
  const z = TN_W.b
    + TN_W.elo * ((H.elo - A.elo) / 400) * Math.LN10
    + TN_W.form * (mean(H.r) - mean(A.r))
    + TN_W.gs * (mean(H.g) - mean(A.g))
    + TN_W.h2h * ((hw + 1) / (hn + 2) - 0.5) * Math.min(hn, 5) / 5
    + TN_W.rest * (restOf(H, t) - restOf(A, t))
    + TN_W.career * (careerLogit(H) - careerLogit(A));
  return 1 / (1 + Math.exp(-z));
}

/** Learn one finished match. Mutates both rows. */
export function learnTennis(H, A, homeWon, games, start) {
  const y = homeWon ? 1 : 0;
  const exp = 1 / (1 + Math.pow(10, (A.elo - H.elo) / 400));
  const kH = kOf(H.n), kA = kOf(A.n);
  H.elo += kH * (y - exp);
  A.elo -= kA * (y - exp);
  for (const [p, won, home] of [[H, y, true], [A, 1 - y, false]]) {
    p.n = (p.n || 0) + 1;
    p.w = (p.w || 0) + won;
    p.r = [...(p.r || []), won].slice(-20);
    p.g = [...(p.g || []), gamesShare(games, home)].slice(-10);
    p.last = Math.max(p.last || 0, Number(start) || 0);
  }
}

let ready = false;
async function ensure() {
  if (ready) return;
  await ensureTnHist();
  await sql`CREATE TABLE IF NOT EXISTS tn_ratings (
    k TEXT PRIMARY KEY, display TEXT,
    elo DOUBLE PRECISION NOT NULL DEFAULT 1500,
    n INT NOT NULL DEFAULT 0, w INT NOT NULL DEFAULT 0,
    last BIGINT, rec TEXT,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS tn_h2h (
    a TEXT NOT NULL, b TEXT NOT NULL, n INT NOT NULL DEFAULT 0, aw INT NOT NULL DEFAULT 0,
    PRIMARY KEY (a, b)
  )`;
  ready = true;
}

function parseRow(r) {
  let rec = {};
  try { rec = JSON.parse(r.rec || "{}") || {}; } catch { rec = {}; }
  return { k: r.k, display: r.display, elo: Number(r.elo) || 1500, n: r.n || 0, w: r.w || 0,
    last: Number(r.last) || 0, r: rec.r || [], g: rec.g || [] };
}

async function loadPlayers(keys) {
  const list = [...new Set(keys)].filter(Boolean);
  const map = new Map();
  for (let i = 0; i < list.length; i += 500) {
    const rows = await sql`SELECT * FROM tn_ratings WHERE k = ANY(${list.slice(i, i + 500)})`;
    for (const r of rows) map.set(r.k, parseRow(r));
  }
  return map;
}

async function loadH2H(pairs) {
  const as = [], bs = [];
  for (const [a, b] of pairs) { if (a && b) { as.push(a); bs.push(b); } }
  const map = new Map();
  if (!as.length) return map;
  const rows = await sql`
    SELECT t.a, t.b, t.n, t.aw FROM tn_h2h t
    JOIN (SELECT unnest(${as}::text[]) AS a, unnest(${bs}::text[]) AS b) v ON t.a = v.a AND t.b = v.b`;
  for (const r of rows) map.set(r.a + ">" + r.b, { n: r.n, hw: r.aw });
  return map;
}

/** Learn finished matches oldest first, writing each one's pre-match % first. */
export async function trainTennis(limit = 3000, deadlineMs = 12000) {
  await ensure();
  const deadline = Date.now() + deadlineMs;
  const games = await sql`
    SELECT match_id, home, away, start_at, r_home, r_away, games FROM tn_games
    WHERE trained IS NOT TRUE ORDER BY start_at ASC LIMIT ${limit}`;
  if (!games.length) return { trained: 0 };
  const players = await loadPlayers(games.flatMap((g) => [tnKey(g.home), tnKey(g.away)]));
  const h2h = await loadH2H(games.map((g) => [tnKey(g.home), tnKey(g.away)]));
  const P = (k, name) => {
    let p = players.get(k);
    if (!p) { p = { k, display: name, elo: 1500, n: 0, w: 0, last: 0, r: [], g: [] }; players.set(k, p); }
    p.dirty = true;
    return p;
  };
  const pre = [], done = [], pairs = new Map();
  for (const g of games) {
    if (Date.now() > deadline) break;
    done.push(g.match_id);
    const kH = tnKey(g.home), kA = tnKey(g.away);
    if (!kH || !kA || kH === kA) continue;
    const H = P(kH, g.home), A = P(kA, g.away);
    const rec = h2h.get(kH + ">" + kA) || { n: 0, hw: 0 };
    const s = statsTennis(H, A, rec, g.start_at);
    if (s != null) pre.push([g.match_id, s]);
    const y = Number(g.r_home) > Number(g.r_away);
    learnTennis(H, A, y, g.games, g.start_at);
    h2h.set(kH + ">" + kA, { n: rec.n + 1, hw: rec.hw + (y ? 1 : 0) });
    const back = h2h.get(kA + ">" + kH) || { n: 0, hw: 0 };
    h2h.set(kA + ">" + kH, { n: back.n + 1, hw: back.hw + (y ? 0 : 1) });
    for (const [a, b, w] of [[kH, kA, y ? 1 : 0], [kA, kH, y ? 0 : 1]]) {
      const x = pairs.get(a + ">" + b) || { a, b, n: 0, aw: 0 };
      x.n++; x.aw += w; pairs.set(a + ">" + b, x);
    }
  }
  const dirty = [...players.values()].filter((p) => p.dirty);
  for (let i = 0; i < dirty.length; i += 300) {
    const p = dirty.slice(i, i + 300);
    await sql`
      INSERT INTO tn_ratings (k, display, elo, n, w, last, rec, updated)
      SELECT k, d, e, n, w, l, r, now() FROM unnest(
        ${p.map((x) => x.k)}::text[], ${p.map((x) => x.display)}::text[], ${p.map((x) => x.elo)}::float8[],
        ${p.map((x) => x.n)}::int[], ${p.map((x) => x.w)}::int[], ${p.map((x) => x.last)}::bigint[],
        ${p.map((x) => JSON.stringify({ r: x.r, g: x.g.map((v) => Math.round(v * 1000) / 1000) }))}::text[])
        AS v(k, d, e, n, w, l, r)
      ON CONFLICT (k) DO UPDATE SET elo = EXCLUDED.elo, n = EXCLUDED.n, w = EXCLUDED.w,
        last = EXCLUDED.last, rec = EXCLUDED.rec, updated = now()`;
  }
  const pl = [...pairs.values()];
  for (let i = 0; i < pl.length; i += 500) {
    const p = pl.slice(i, i + 500);
    await sql`
      INSERT INTO tn_h2h (a, b, n, aw)
      SELECT * FROM unnest(${p.map((x) => x.a)}::text[], ${p.map((x) => x.b)}::text[],
        ${p.map((x) => x.n)}::int[], ${p.map((x) => x.aw)}::int[])
      ON CONFLICT (a, b) DO UPDATE SET n = tn_h2h.n + EXCLUDED.n, aw = tn_h2h.aw + EXCLUDED.aw`;
  }
  for (let i = 0; i < pre.length; i += 500) {
    const p = pre.slice(i, i + 500);
    await sql`UPDATE tn_games t SET pre_stats = v.s
      FROM (SELECT unnest(${p.map((x) => x[0])}::text[]) AS id, unnest(${p.map((x) => x[1])}::float8[]) AS s) v
      WHERE t.match_id = v.id`;
  }
  for (let i = 0; i < done.length; i += 500) {
    await sql`UPDATE tn_games SET trained = TRUE WHERE match_id = ANY(${done.slice(i, i + 500)})`;
  }
  return { trained: done.length, graded: pre.length };
}

/** Puts g.stats = { home, away } (whole %), g.nH / g.nA and g.h2h on card games. */
export async function forecastTennis(games) {
  await ensure();
  const singles = (games || []).filter((g) => g && g.home && g.away && !/\//.test(g.home + g.away));
  const players = await loadPlayers(singles.flatMap((g) => [tnKey(g.home), tnKey(g.away)]));
  // The card sometimes shortens a first name ("Coulibaly, E") that the results
  // spell out ("Coulibaly, Eliakim"): take the one full name that fits.
  const alias = new Map();
  for (const name of new Set(singles.flatMap((g) => [g.home, g.away]))) {
    const m = String(name).match(/^\s*([^,]+?)\s*,\s*([A-Za-z])\.?\s*$/);
    if (!m || players.has(tnKey(name))) continue;
    const rows = await sql`SELECT * FROM tn_ratings WHERE display ILIKE ${m[1] + ", " + m[2] + "%"} LIMIT 2`;
    if (rows.length === 1) { const p = parseRow(rows[0]); players.set(p.k, p); alias.set(tnKey(name), p.k); }
  }
  const keyOf = (name) => alias.get(tnKey(name)) || tnKey(name);
  const h2h = await loadH2H(singles.map((g) => [keyOf(g.home), keyOf(g.away)]));
  for (const g of singles) {
    const kH = keyOf(g.home), kA = keyOf(g.away);
    const H = players.get(kH), A = players.get(kA);
    const rec = h2h.get(kH + ">" + kA) || { n: 0, hw: 0 };
    g.nH = H ? H.n : 0;
    g.nA = A ? A.n : 0;
    g.h2h = rec;
    const s = statsTennis(H, A, rec, g.start);
    g.stats = s == null ? null : { home: Math.round(s * 100), away: 100 - Math.round(s * 100) };
  }
  return games;
}

/** How the pre-match % did on matches it never saw, by confidence band. */
export async function recordTennisStats() {
  await ensure();
  const rows = await sql`
    SELECT floor(greatest(pre_stats, 1 - pre_stats) * 20) / 20 AS band, count(*)::int AS n,
      sum(CASE WHEN (pre_stats >= 0.5) = (r_home > r_away) THEN 1 ELSE 0 END)::int AS won
    FROM tn_games WHERE pre_stats IS NOT NULL GROUP BY 1 ORDER BY 1`;
  return rows.map((r) => ({ band: Number(r.band), n: r.n, won: r.won }));
}
