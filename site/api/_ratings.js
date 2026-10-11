// Online rating store. One row per player; each finished game trains its two
// players exactly once (marked tt_games.trained) and is never re-read. To score
// the card we load only the ~100 players actually playing and hand them to the
// existing forecastTT — so the model math is unchanged, but there is no 11MB
// pack, no full retrain, and a new result shows the instant it's trained.
import { sql } from "./_db.js";
import { forecastTT, winPctBook } from "./_tt.js";
import { gradeHoldout } from "./_grade.js";

// Must fold identically to _tt.js nameKey, or card lookups miss.
function foldToken(t) {
  return t.replace(/SKYI$/g, "SKI").replace(/SKIY$/g, "SKI").replace(/SKII$/g, "SKI")
    .replace(/SKYJ$/g, "SKI").replace(/YI$/g, "I").replace(/IY$/g, "I");
}
function nameTokens(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z]+/g, " ").trim()
    .split(/\s+/).filter((t) => t.length > 1).map(foldToken);
}
function nameKey(s) { return nameTokens(s).sort().join("|"); }
function tournKey(t) {
  return String(t || "").toLowerCase().replace(/[^a-z0-9]+/g, "").replace(/\d+$/, "");
}
function patternPts(w, l) {
  w = Number(w); l = Number(l);
  if (!isFinite(w) || !isFinite(l) || w + l <= 0) return 0;
  if (l === 0) return 3;
  if (w - l <= 1) return 1;
  return 2;
}
const REC_CAP = 80;

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS tt_ratings (
    name_key TEXT PRIMARY KEY,
    display TEXT,
    elo DOUBLE PRECISION NOT NULL DEFAULT 1500,
    n INT NOT NULL DEFAULT 0,
    w INT NOT NULL DEFAULT 0,
    last BIGINT,
    rec TEXT,
    tourn TEXT,
    setka DOUBLE PRECISION,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE TABLE IF NOT EXISTS tt_rating_meta (k TEXT PRIMARY KEY, data TEXT)`;
  await sql`ALTER TABLE tt_games ADD COLUMN IF NOT EXISTS trained BOOLEAN NOT NULL DEFAULT FALSE`;
  // Our home % for the game, written by trainBatch from the ratings as they
  // stood BEFORE that game's result was learned. The holdout reads only this.
  await sql`ALTER TABLE tt_games ADD COLUMN IF NOT EXISTS pre_home INT`;
  await sql`ALTER TABLE tt_games ADD COLUMN IF NOT EXISTS pre_stats INT`;
  // Full head-to-head per pair (a < b by key; aw = a's wins). The players'
  // last-80 record saw a median 3 meetings per pair where history holds 11,
  // and head-to-head is the stats model's strongest input.
  await sql`CREATE TABLE IF NOT EXISTS tt_h2h (
    a TEXT NOT NULL, b TEXT NOT NULL, n INT NOT NULL DEFAULT 0, aw INT NOT NULL DEFAULT 0,
    PRIMARY KEY (a, b)
  )`;
  // Sets in those meetings (sn = sets played, asw = a's sets won): a 3-0 and a
  // 3-2 are not the same win, and the share of sets is the best h2h signal.
  await sql`ALTER TABLE tt_h2h ADD COLUMN IF NOT EXISTS sn INT NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE tt_h2h ADD COLUMN IF NOT EXISTS asw INT NOT NULL DEFAULT 0`;
  await sql`CREATE INDEX IF NOT EXISTS tt_games_untrained
    ON tt_games (start_at) WHERE trained IS NOT TRUE`;
  ready = true;
}

function blankPlayer(key, setka) {
  // Seed a brand-new player off their official Setka rating when we have one, so
  // a player with 2 banked games isn't a blank 1500. Matches then refine it.
  let elo = 1500;
  if (setka != null && isFinite(setka)) {
    elo = 1500 + Math.max(-300, Math.min(300, (Number(setka) - 50) * 6));
  }
  return { key, display: null, elo, n: 0, w: 0, last: 0, rec: [], tourn: {}, setka: setka ?? null, dirty: true };
}

function parsePlayer(row) {
  let rec = [], tourn = {};
  try { rec = row.rec ? JSON.parse(row.rec) : []; } catch { rec = []; }
  try { tourn = row.tourn ? JSON.parse(row.tourn) : {}; } catch { tourn = {}; }
  return {
    key: row.name_key, display: row.display || null,
    elo: Number(row.elo) || 1500, n: row.n || 0, w: row.w || 0,
    last: row.last ? Number(row.last) : 0, rec, tourn,
    setka: row.setka == null ? null : Number(row.setka), dirty: false,
  };
}

async function loadMeta() {
  const r = await sql`SELECT data FROM tt_rating_meta WHERE k = 'main'`;
  if (r[0] && r[0].data) { try { return JSON.parse(r[0].data); } catch { /* */ } }
  return { homeN: 0, homeW: 0, bt: { n: 0, hit: 0, brier: 0, strongN: 0, strongW: 0 } };
}

/** Train the next chunk of untrained finished games, oldest first. Each game
 *  updates only its two players. Returns how many it trained and how many
 *  remain. Safe to call repeatedly — a game is trained once. */
export async function trainBatch(limit = 2500, deadlineMs = 12000) {
  await ensure();
  const deadline = Date.now() + deadlineMs;
  const games = await sql`
    SELECT match_id, home, away, tourn, start_at, r_home, r_away, win_home, win_away
    FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL AND trained IS NOT TRUE
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  if (!games.length) return { trained: 0, remaining: 0, done: true };

  // keys involved + their setka seed
  const keys = new Set();
  for (const g of games) { keys.add(nameKey(g.home)); keys.add(nameKey(g.away)); }
  const keyList = [...keys].filter(Boolean);
  const rows = keyList.length
    ? await sql`SELECT * FROM tt_ratings WHERE name_key = ANY(${keyList})` : [];
  const players = new Map(rows.map((r) => [r.name_key, parsePlayer(r)]));
  let seed = new Map();
  try {
    const sr = keyList.length
      ? await sql`SELECT name_key, rating FROM tt_setka_players WHERE name_key = ANY(${keyList}) AND rating IS NOT NULL` : [];
    seed = new Map(sr.map((r) => [r.name_key, Number(r.rating)]));
  } catch { seed = new Map(); }
  const P = (key) => {
    let p = players.get(key);
    if (!p) { p = blankPlayer(key, seed.get(key)); players.set(key, p); }
    return p;
  };

  const meta = await loadMeta();
  const bt = meta.bt || { n: 0, hit: 0, brier: 0, strongN: 0, strongW: 0 };
  const ha = homeAdv(meta);
  let h2hMap = null;
  try { h2hMap = await loadH2H(games.map((g) => [nameKey(g.home), nameKey(g.away)])); } catch { h2hMap = null; }
  const h2hAdd = new Map();   // pair -> { n, aw } added by this batch
  const done = [];
  const pre = [];
  for (const g of games) {
    if (Date.now() > deadline) break;
    const kH = nameKey(g.home), kA = nameKey(g.away);
    if (!kH || !kA || kH === kA) { done.push(g.match_id); continue; }
    const H = P(kH), A = P(kA);
    if (!H.display) H.display = g.home;
    if (!A.display) A.display = g.away;
    const rh = Number(g.r_home), ra = Number(g.r_away);
    const hw = rh > ra;
    const need = Math.max(rh, ra) || 3;
    const margin = Math.abs(rh - ra) / need;
    const exp = 1 / (1 + 10 ** ((A.elo - H.elo) / 400));
    const st0 = g.start_at ? Number(g.start_at) : 0;
    // Score the game the way the card would have, before learning its result.
    // A copy of this match banked from another feed may already be in the
    // record; then the result has leaked and the game is not graded.
    const wh = Number(g.win_home), wa = Number(g.win_away);
    if (wh > 1 && wa > 1 && !alreadySeen(H.rec, kA, st0) && !alreadySeen(A.rec, kH, st0)) {
      const one = { home: g.home, away: g.away, tourn: g.tourn, start: st0, win: { home: wh, away: wa } };
      scoreOne({ [kH]: H, [kA]: A }, ha, one, h2hMap);
      if (one.ours || one.stats) pre.push([g.match_id, one.ours ? one.ours.home : null, one.stats ? one.stats.home : null]);
    }
    // Count the meeting once: a copy of this match from another feed may
    // already be in the record (same pair within 15 minutes).
    if (h2hMap && !alreadySeen(H.rec, kA, st0)) {
      const [a, b] = pairOf(kH, kA);
      const k2 = a + ">" + b;
      const r = h2hMap.get(k2) || { n: 0, aw: 0, sn: 0, asw: 0 };
      const aWon = (hw ? kH : kA) === a;
      const aSets = kH === a ? rh : ra;
      r.n++; if (aWon) r.aw++; r.sn += rh + ra; r.asw += aSets;
      h2hMap.set(k2, r);
      const d = h2hAdd.get(k2) || { n: 0, aw: 0, sn: 0, asw: 0 };
      d.n++; if (aWon) d.aw++; d.sn += rh + ra; d.asw += aSets;
      h2hAdd.set(k2, d);
    }
    // walk-forward self-check, before the update
    if (H.n >= 5 && A.n >= 5) {
      const y = hw ? 1 : 0;
      bt.n++; bt.brier += (exp - y) * (exp - y);
      const right = (exp >= 0.5) === (y === 1);
      if (right) bt.hit++;
      if (Math.max(exp, 1 - exp) >= 0.65) { bt.strongN++; if (right) bt.strongW++; }
    }
    const k = 12 + 20 * margin;
    H.elo += k * ((hw ? 1 : 0) - exp);
    A.elo += k * ((hw ? 0 : 1) - (1 - exp));
    const st = g.start_at ? Number(g.start_at) : 0;
    H.n++; A.n++; if (hw) H.w++; else A.w++;
    if (st > H.last) H.last = st;
    if (st > A.last) A.last = st;
    const T = tournKey(g.tourn);
    H.rec.push({ t: st, won: hw, vs: kA, sw: rh, sl: ra, tourn: T || "" });
    A.rec.push({ t: st, won: !hw, vs: kH, sw: ra, sl: rh, tourn: T || "" });
    if (H.rec.length > REC_CAP) H.rec.shift();
    if (A.rec.length > REC_CAP) A.rec.shift();
    if (T) {
      const ht = H.tourn[T] || (H.tourn[T] = { n: 0, w: 0 });
      const at = A.tourn[T] || (A.tourn[T] = { n: 0, w: 0 });
      ht.n++; at.n++; if (hw) ht.w++; else at.w++;
    }
    meta.homeN = (meta.homeN || 0) + 1; if (hw) meta.homeW = (meta.homeW || 0) + 1;
    H.dirty = true; A.dirty = true;
    done.push(g.match_id);
  }

  // Write players first, then mark games trained — so a crash re-trains at worst
  // a handful, never loses a rating update.
  const dirty = [...players.values()].filter((p) => p.dirty);
  for (let i = 0; i < dirty.length; i += 25) {
    await Promise.all(dirty.slice(i, i + 25).map((p) => sql`
      INSERT INTO tt_ratings (name_key, display, elo, n, w, last, rec, tourn, setka, updated)
      VALUES (${p.key}, ${p.display}, ${p.elo}, ${p.n}, ${p.w}, ${p.last},
              ${JSON.stringify(p.rec)}, ${JSON.stringify(p.tourn)}, ${p.setka}, now())
      ON CONFLICT (name_key) DO UPDATE SET
        display = COALESCE(EXCLUDED.display, tt_ratings.display),
        elo = EXCLUDED.elo, n = EXCLUDED.n, w = EXCLUDED.w, last = EXCLUDED.last,
        rec = EXCLUDED.rec, tourn = EXCLUDED.tourn,
        setka = COALESCE(EXCLUDED.setka, tt_ratings.setka), updated = now()`));
  }
  meta.bt = bt;
  await sql`INSERT INTO tt_rating_meta (k, data) VALUES ('main', ${JSON.stringify(meta)})
    ON CONFLICT (k) DO UPDATE SET data = ${JSON.stringify(meta)}`;
  // Add this batch's meetings on top, so two overlapping runs never overwrite
  // each other's counts.
  if (h2hAdd.size) {
    const list = [...h2hAdd];
    for (let i = 0; i < list.length; i += 300) {
      const part = list.slice(i, i + 300).map(([k2, d]) => { const [a, b] = k2.split(">"); return [a, b, d.n, d.aw, d.sn, d.asw]; });
      await sql`INSERT INTO tt_h2h (a, b, n, aw, sn, asw)
        SELECT * FROM unnest(${part.map((x) => x[0])}::text[], ${part.map((x) => x[1])}::text[],
                             ${part.map((x) => x[2])}::int[], ${part.map((x) => x[3])}::int[],
                             ${part.map((x) => x[4])}::int[], ${part.map((x) => x[5])}::int[])
        ON CONFLICT (a, b) DO UPDATE SET n = tt_h2h.n + EXCLUDED.n, aw = tt_h2h.aw + EXCLUDED.aw,
          sn = tt_h2h.sn + EXCLUDED.sn, asw = tt_h2h.asw + EXCLUDED.asw`;
    }
  }
  for (let i = 0; i < pre.length; i += 200) {
    const part = pre.slice(i, i + 200);
    await sql`UPDATE tt_games t SET pre_home = v.p, pre_stats = v.s
      FROM (SELECT unnest(${part.map((x) => x[0])}::text[]) AS id,
                   unnest(${part.map((x) => x[1])}::int[]) AS p,
                   unnest(${part.map((x) => x[2])}::int[]) AS s) v
      WHERE t.match_id = v.id`;
  }
  for (let i = 0; i < done.length; i += 200) {
    await sql`UPDATE tt_games SET trained = TRUE WHERE match_id = ANY(${done.slice(i, i + 200)})`;
  }

  const rem = await sql`SELECT count(*)::int AS c FROM tt_games
    WHERE r_home IS NOT NULL AND r_away IS NOT NULL AND trained IS NOT TRUE`;
  const remaining = rem[0] ? rem[0].c : 0;
  return { trained: done.length, remaining, done: remaining === 0 };
}

// Build a tiny pack (only the players on the card) and derive their head-to-head
// from the stored recent record, then reuse the existing forecast + field shape.
function h2hFromRec(rec, oppKey, start, tourn) {
  const T = tournKey(tourn);
  const row = { n: 0, hw: 0, hs: 0, as: 0, hW3: 0, hW2: 0, hW1: 0, aW3: 0, aW2: 0, aW1: 0 };
  for (const x of rec || []) {
    if (x.vs !== oppKey) continue;
    const t = Number(x.t) || 0;
    const now = Number(start) || Date.now();
    if (t && t < now - 120 * 86400000) continue;
    if (T && x.tourn && tournKey(x.tourn) !== T) continue;
    const sw = Number(x.sw), sl = Number(x.sl);
    row.n++; if (x.won) row.hw++;
    row.hs += isFinite(sw) ? sw : 0; row.as += isFinite(sl) ? sl : 0;
    const p = patternPts(sw, sl);
    if (x.won) { if (p === 3) row.hW3++; else if (p === 2) row.hW2++; else if (p === 1) row.hW1++; }
    else { if (p === 3) row.aW3++; else if (p === 2) row.aW2++; else if (p === 1) row.aW1++; }
  }
  return row;
}

async function loadCardPlayers(games) {
  const exact = new Set();
  for (const g of games) { exact.add(nameKey(g.home)); exact.add(nameKey(g.away)); }
  const keyList = [...exact].filter(Boolean);
  const players = {};
  if (keyList.length) {
    const rows = await sql`SELECT * FROM tt_ratings WHERE name_key = ANY(${keyList})`;
    for (const r of rows) { const p = parsePlayer(r); players[p.key] = p; }
  }
  // Surname-only fuzzy used to attach the most-played "Kowalczyk" to a
  // different Marcin. Only fill a miss when exactly one row has every token.
  const misses = keyList.filter((k) => !players[k]).slice(0, 40);
  for (const k of misses) {
    const toks = k.split("|").filter((t) => t.length >= 3);
    if (toks.length < 2) continue;
    const long = toks.slice().sort((a, b) => b.length - a.length)[0];
    try {
      const cand = await sql`SELECT * FROM tt_ratings WHERE name_key LIKE ${"%" + long + "%"}
        ORDER BY n DESC, name_key ASC LIMIT 8`;
      const hit = cand.filter((r) => {
        const set = new Set(String(r.name_key || "").split("|"));
        return toks.every((t) => set.has(t));
      });
      if (hit.length === 1 && !players[hit[0].name_key]) {
        players[hit[0].name_key] = parsePlayer(hit[0]);
      }
    } catch { /* skip */ }
  }
  return players;
}

// Stats-only win chance — player numbers, never the price. A logistic fit on
// 189k older games, tested on the newest 81k it never saw: when it said
// 70-75% the player won 73%, 75-80% won 79%, 80-85% won 85%, 85%+ won 92%.
// On SportyBet's own games, 75%+ won 63 of 74 (+10.9% at the posted price).
// Inputs: rating gap, last-20 form gap (a hot streak counts slightly against,
// it cools), head-to-head, rest, career win rate, and from the set scores:
// share of sets won over the last 20 (a run of 3-2s is weaker than 3-0s) and
// share of sets won head-to-head (now the strongest input; it takes over most
// of plain h2h wins, whose weight turns slightly negative alongside it).
// Refit with the set inputs on the same 81k unseen games: 70-75% won 72%,
// 75-80% won 78%, 80-85% won 84%, 85%+ won 91%; 9% more games reach 70%+.
const STATS_W = { b: -0.0169, elo: 0.4444, form: -1.0269, h2h: -0.7784, rest: -0.0443, career: 0.1434,
  setForm: 1.1308, h2hSet: 4.8315 };
const pairOf = (x, y) => (x < y ? [x, y] : [y, x]);
// { hw, hn } for x against y out of the full head-to-head map, or null.
function h2hOf(map, x, y) {
  if (!map) return null;
  const [a, b] = pairOf(x, y);
  const r = map.get(a + ">" + b);
  if (!r) return { hw: 0, hn: 0, hs: 0, hsn: 0 };
  return { hw: x === a ? r.aw : r.n - r.aw, hn: r.n, hs: x === a ? r.asw : r.sn - r.asw, hsn: r.sn };
}
async function loadH2H(pairs) {
  const map = new Map();
  const list = [...new Set(pairs.map(([x, y]) => pairOf(x, y).join(">")))];
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    const rows = await sql`SELECT a, b, n, aw, sn, asw FROM tt_h2h WHERE (a || '>' || b) = ANY(${part})`;
    for (const r of rows) map.set(r.a + ">" + r.b, { n: r.n, aw: r.aw, sn: r.sn || 0, asw: r.asw || 0 });
  }
  return map;
}

export function statsHome(H, A, kH, kA, start, full) {
  if (!H || !A || (H.n || 0) < 10 || (A.n || 0) < 10) return null;
  const recH = H.rec || [], recA = A.rec || [];
  if (!recH.length || !recA.length) return null;
  const form = (rec) => { const r = rec.slice(-20); return r.reduce((s, x) => s + (x.won ? 1 : 0), 0) / r.length; };
  let hw = 0, hn = 0, hs = 0, hsn = 0;
  if (full) { hw = full.hw; hn = full.hn; hs = full.hs || 0; hsn = full.hsn || 0; }
  else for (const x of recH) if (x.vs === kA) { hn++; if (x.won) hw++; }
  // Sets head-to-head; from the record when the full table has none yet.
  if (!hsn) {
    hs = 0;
    for (const x of recH) if (x.vs === kA && isFinite(Number(x.sw)) && isFinite(Number(x.sl))) { hs += Number(x.sw); hsn += Number(x.sw) + Number(x.sl); }
  }
  const setForm = (rec) => {
    let w = 0, n = 0;
    for (const x of rec.slice(-20)) { const a = Number(x.sw), b = Number(x.sl); if (isFinite(a) && isFinite(b)) { w += a; n += a + b; } }
    return n ? w / n : 0.5;
  };
  const t = Number(start) || Date.now();
  const rest = (p) => Math.log1p(p.last ? Math.min(Math.max(0, (t - p.last) / 60000), 600) : 600);
  const car = (p) => { const c = ((p.w || 0) + 1) / ((p.n || 0) + 2); return Math.log(c / (1 - c)); };
  const z = STATS_W.b
    + STATS_W.elo * ((H.elo - A.elo) / 400) * Math.LN10
    + STATS_W.form * (form(recH) - form(recA))
    + STATS_W.h2h * ((hw + 1) / (hn + 2) - 0.5) * Math.min(hn, 10) / 10
    + STATS_W.rest * (rest(H) - rest(A))
    + STATS_W.career * (car(H) - car(A))
    + STATS_W.setForm * (setForm(recH) - setForm(recA))
    + STATS_W.h2hSet * ((hs + 2) / (hsn + 4) - 0.5) * Math.min(hn, 10) / 10;
  return 1 / (1 + Math.exp(-z));
}

function homeAdv(meta) {
  return meta.homeN >= 200 ? Math.min(0.05, Math.max(-0.05, (meta.homeW / meta.homeN) - 0.5)) : 0;
}

// True when the record already holds this pairing within 15 minutes of start —
// the same match, banked under another feed's id.
function alreadySeen(rec, oppKey, start) {
  if (!start) return false;
  return (rec || []).some((x) => x.vs === oppKey && Math.abs((Number(x.t) || 0) - start) < 15 * 60000);
}

// Sets the fields the page reads (pct / ours / book / nH / nA / h2hRec /
// formH / formA) on one game, from whatever player rows it is handed.
function scoreOne(players, ha, g, h2hMap, alias) {
  const kH = nameKey(g.home), kA = nameKey(g.away);
  // The record's own keys (another spelling when the card's was thin).
  const eH = (alias && alias.get(kH)) || kH, eA = (alias && alias.get(kA)) || kA;
  const H = players[kH];
  const h2h = {};
  if (H && H.rec) h2h[kH + ">" + kA] = h2hFromRec(H.rec, eA, g.start, g.tourn);
  const f = forecastTT({ players, h2h, ha }, g);
  const book = g.win ? winPctBook(g.win.home, g.win.away) : null;
  const h2hN = f.h2hRec ? f.h2hRec.n : 0;
  const hasForm = !!(f.formH && f.formA);
  const evidence = (f.nH || 0) + (f.nA || 0) + 3 * h2hN + (hasForm ? 6 : 0);
  const pHome = Math.min(0.97, Math.max(0.03, f.pHome));
  const ours = { home: Math.round(pHome * 100), away: Math.round((1 - pHome) * 100) };
  const thin = ((f.nH || 0) < 15 || (f.nA || 0) < 15) && h2hN < 5;
  g.pct = !thin && evidence >= 1 ? ours : null;
  g.ours = !thin && evidence >= 1 ? ours : null;
  g.book = book ? { home: Math.round(book.home * 100), away: Math.round(book.away * 100) } : null;
  g.nH = f.nH; g.nA = f.nA;
  g.h2hRec = f.h2hRec;
  g.formH = f.formH; g.formA = f.formA;
  const s = statsHome(players[kH], players[kA], eH, eA, g.start, h2hOf(h2hMap, eH, eA));
  g.stats = s == null ? null : { home: Math.round(s * 100), away: 100 - Math.round(s * 100) };
  return g;
}

/** Forecast the upcoming card off the rating store. */
// The same given name spelled from Ukrainian, Russian or English: SportyBet's
// "Lapa, Hanna" (29 games) is the Setka feed's "Anna Lapa" (467).
const GIVEN = [
  ["HANNA", "ANNA"], ["OLEKSANDR", "ALEKSANDR", "ALEXANDR", "ALEXANDER"], ["OLEKSII", "OLEKSIY", "ALEKSEI", "ALEKSEY", "ALEXEI", "ALEXEY"],
  ["YEVHEN", "YEVHENII", "EVGENII", "EVGENIY", "EVGENY", "YEVGENIY"], ["SERHII", "SERHIY", "SERGEI", "SERGEY", "SERGII", "SERGIY"],
  ["MYKOLA", "NIKOLAI", "NIKOLAY"], ["MYKHAILO", "MIKHAIL", "MYKHAYLO"], ["DMYTRO", "DMITRII", "DMITRIY", "DMITRY"],
  ["ANDRII", "ANDRIY", "ANDREI", "ANDREY"], ["YURII", "YURIY", "YURI"], ["VIKTOR", "VICTOR"], ["VOLODYMYR", "VLADIMIR"],
  ["PAVLO", "PAVEL"], ["PETRO", "PETR"], ["OLENA", "ELENA", "YELENA"], ["YULIIA", "YULIA", "IULIIA"], ["NATALIIA", "NATALIA", "NATALYA"],
  ["KATERYNA", "EKATERINA", "YEKATERINA"], ["TETIANA", "TATIANA", "TATYANA"], ["IRYNA", "IRINA"], ["MARIIA", "MARIA"],
  ["VALERII", "VALERIY", "VALERY"], ["VITALII", "VITALIY", "VITALY"], ["ANATOLII", "ANATOLIY", "ANATOLY"], ["HENNADII", "GENNADII", "GENNADY"],
].map((g) => g.map(foldToken));
function nameVariants(key) {
  const toks = String(key || "").split("|");
  const out = new Set();
  toks.forEach((t, i) => {
    for (const g of GIVEN) if (g.includes(t)) for (const v of g) if (v !== t) {
      const c = toks.slice(); c[i] = v; out.add(c.sort().join("|"));
    }
  });
  return [...out];
}

// Card key -> the key of the same player's bigger record under another
// spelling, when the card's own record is thin (< 30) and the other has played
// the same competition ("setkacup" also matches "setkacupwomen").
async function aliasThin(games, players) {
  const alias = new Map();
  const want = new Map();
  for (const g of games) for (const nm of [g.home, g.away]) {
    const k = nameKey(nm);
    if (!k || alias.has(k) || (players[k] && players[k].n >= 30)) continue;
    const vs = nameVariants(k);
    if (vs.length) want.set(k, { vs, T: tournKey(g.tourn) });
  }
  const all = [...new Set([...want.values()].flatMap((w) => w.vs))];
  if (!all.length) return alias;
  const rows = await sql`SELECT * FROM tt_ratings WHERE name_key = ANY(${all.slice(0, 400)})`;
  const byKey = new Map(rows.map((r) => [r.name_key, parsePlayer(r)]));
  for (const [k, w] of want) {
    const own = players[k] ? players[k].n : 0;
    const best = w.vs.map((v) => byKey.get(v)).filter((p) => p && p.n > own && (!w.T || Object.keys(p.tourn || {}).some((t) => t.startsWith(w.T) || w.T.startsWith(t))))
      .sort((a, b) => b.n - a.n)[0];
    if (best) { alias.set(k, best.key); players[k] = best; }
  }
  return alias;
}

export async function forecastCard(games) {
  await ensure();
  const players = await loadCardPlayers(games);
  let alias = new Map();
  try { alias = await aliasThin(games, players); } catch { alias = new Map(); }
  const eff = (nm) => { const k = nameKey(nm); return alias.get(k) || k; };
  const ha = homeAdv(await loadMeta());
  let h2hMap = null;
  try { h2hMap = await loadH2H(games.map((g) => [eff(g.home), eff(g.away)])); } catch { h2hMap = null; }
  for (const g of games) scoreOne(players, ha, g, h2hMap, alias);
  return games;
}

export async function ratingsMeta() {
  await ensure();
  const meta = await loadMeta();
  const bt = meta.bt || {};
  const c = await sql`SELECT count(*)::int AS players FROM tt_ratings`;
  let holdout = null;
  try {
    const h = await sql`SELECT data FROM tt_rating_meta WHERE k = 'holdout'`;
    if (h[0] && h[0].data) holdout = JSON.parse(h[0].data);
  } catch { holdout = null; }
  return {
    players: c[0] ? c[0].players : 0,
    nGames: meta.homeN || 0,
    backtest: bt.n ? {
      n: bt.n, hit: bt.hit / bt.n, brier: bt.brier / bt.n,
      strongN: bt.strongN, strongHit: bt.strongN ? bt.strongW / bt.strongN : null,
    } : null,
    holdout,
  };
}

/** Last N days of finished SportyBet games, graded on the % we wrote down
 *  before each result was learned (pre_home) — never on today's ratings, which
 *  have already trained on those same games. "Beat the book" = our favourite
 *  ≥60% AND ≥5pp above the book's % on that side. Proven only if backing that
 *  bucket at the posted price made money, and the hit rate's lower bound clears
 *  the rate those prices need to break even. */
export async function scoreHoldout(days = 14, opts = {}) {
  await ensure();
  if (!opts.force) {
    try {
      const prev = await sql`SELECT data FROM tt_rating_meta WHERE k = 'holdout'`;
      const cur = prev[0] && prev[0].data ? JSON.parse(prev[0].data) : null;
      if (cur && cur.v === 3 && cur.at && Date.now() - Date.parse(cur.at) < 6 * 3600 * 1000) return cur;
    } catch { /* score */ }
  }
  const cutoff = Date.now() - days * 86400000;
  const rows = await sql`
    SELECT pre_home, r_home, r_away, win_home, win_away
    FROM tt_games
    WHERE pre_home IS NOT NULL
      AND r_home IS NOT NULL AND r_away IS NOT NULL
      AND win_home IS NOT NULL AND win_away IS NOT NULL
      AND start_at >= ${cutoff}
    ORDER BY start_at ASC
    LIMIT 5000`;
  const out = gradeHoldout(rows.map((r) => ({
    pre: Number(r.pre_home),
    win: { home: Number(r.win_home), away: Number(r.win_away) },
    res: { home: Number(r.r_home), away: Number(r.r_away) },
  })));
  out.v = 3;
  out.days = days;
  out.at = new Date().toISOString();
  await sql`
    INSERT INTO tt_rating_meta (k, data) VALUES ('holdout', ${JSON.stringify(out)})
    ON CONFLICT (k) DO UPDATE SET data = ${JSON.stringify(out)}`;
  return out;
}
