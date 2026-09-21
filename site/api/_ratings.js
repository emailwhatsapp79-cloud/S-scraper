// Online rating store. One row per player; each finished game trains its two
// players exactly once (marked tt_games.trained) and is never re-read. To score
// the card we load only the ~100 players actually playing and hand them to the
// existing forecastTT — so the model math is unchanged, but there is no 11MB
// pack, no full retrain, and a new result shows the instant it's trained.
import { sql } from "./_db.js";
import { forecastTT, winPctBook } from "./_tt.js";

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
    SELECT match_id, home, away, tourn, start_at, r_home, r_away
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
  const done = [];
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
    H.rec.push({ t: st, won: hw, vs: kA, sw: rh, sl: ra });
    A.rec.push({ t: st, won: !hw, vs: kH, sw: ra, sl: rh });
    if (H.rec.length > REC_CAP) H.rec.shift();
    if (A.rec.length > REC_CAP) A.rec.shift();
    const T = tournKey(g.tourn);
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
function h2hFromRec(rec, oppKey) {
  const row = { n: 0, hw: 0, hs: 0, as: 0, hW3: 0, hW2: 0, hW1: 0, aW3: 0, aW2: 0, aW1: 0 };
  for (const x of rec || []) {
    if (x.vs !== oppKey) continue;
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
  // surname fallback for the few card players with no exact row (fuzzy names)
  const misses = keyList.filter((k) => !players[k]).slice(0, 40);
  for (const k of misses) {
    const long = k.split("|").filter((t) => t.length >= 4).sort((a, b) => b.length - a.length)[0];
    if (!long) continue;
    try {
      // Deterministic order (most-played first) so the same candidates resolve
      // every time — otherwise a fuzzy-matched player's % flickers between loads.
      const cand = await sql`SELECT * FROM tt_ratings WHERE name_key LIKE ${"%" + long + "%"}
        ORDER BY n DESC, name_key ASC LIMIT 8`;
      for (const r of cand) if (!players[r.name_key]) players[r.name_key] = parsePlayer(r);
    } catch { /* skip */ }
  }
  return players;
}

/** Forecast the upcoming card off the rating store. Sets the same fields the
 *  page reads (pct / ours / book / nH / nA / h2hRec / formH / formA). */
export async function forecastCard(games) {
  await ensure();
  const players = await loadCardPlayers(games);
  const meta = await loadMeta();
  const ha = meta.homeN >= 200 ? Math.min(0.05, Math.max(-0.05, (meta.homeW / meta.homeN) - 0.5)) : 0;

  // h2h map for exactly the pairs on the card, derived from recent record.
  const h2h = {};
  for (const g of games) {
    const kH = nameKey(g.home), kA = nameKey(g.away);
    const H = players[kH];
    if (H && H.rec) h2h[kH + ">" + kA] = h2hFromRec(H.rec, kA);
  }
  const pack = { players, h2h, ha };

  for (const g of games) {
    const f = forecastTT(pack, g);
    const book = g.win ? winPctBook(g.win.home, g.win.away) : null;
    const h2hN = f.h2hRec ? f.h2hRec.n : 0;
    const hasForm = !!(f.formH && f.formA);
    const evidence = (f.nH || 0) + (f.nA || 0) + 3 * h2hN + (hasForm ? 6 : 0);
    const pHome = Math.min(0.97, Math.max(0.03, f.pHome));
    const ours = { home: Math.round(pHome * 100), away: Math.round((1 - pHome) * 100) };
    g.pct = evidence >= 1 ? ours : null;
    g.ours = evidence >= 1 ? ours : null;
    g.book = book ? { home: Math.round(book.home * 100), away: Math.round(book.away * 100) } : null;
    g.nH = f.nH; g.nA = f.nA;
    g.h2hRec = f.h2hRec;
    g.formH = f.formH; g.formA = f.formA;
  }
  return games;
}

export async function ratingsMeta() {
  await ensure();
  const meta = await loadMeta();
  const bt = meta.bt || {};
  const c = await sql`SELECT count(*)::int AS players FROM tt_ratings`;
  return {
    players: c[0] ? c[0].players : 0,
    nGames: meta.homeN || 0,
    backtest: bt.n ? {
      n: bt.n, hit: bt.hit / bt.n, brier: bt.brier / bt.n,
      strongN: bt.strongN, strongHit: bt.strongN ? bt.strongW / bt.strongN : null,
    } : null,
  };
}
