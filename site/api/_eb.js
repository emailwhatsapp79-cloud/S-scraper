// eBasketball off SportyBet (sr:sport:153). Paper only — nothing here books or
// places a slip. Card in, results in, each finished game trains its two gamers
// once, and the % we would have shown is written on the game before its result
// is learned, so the record grades only what we could have known.
import { sql } from "./_db.js";
import {
  SPORT, normaliseEB, finalScore, gamerKey, splitName, bookHome, predict, learn, pickOf, grade,
} from "./_eb_model.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

async function getJson(path, params, timeoutMs = 8000) {
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

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS eb_games (
    match_id TEXT PRIMARY KEY,
    event_id TEXT,
    home TEXT, away TEXT,
    tourn TEXT,
    start_at BIGINT,
    status TEXT,
    win_home DOUBLE PRECISION,
    win_away DOUBLE PRECISION,
    r_home INT, r_away INT,
    pre_home DOUBLE PRECISION,
    pre_nh INT, pre_na INT,
    trained BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ
  )`;
  await sql`CREATE INDEX IF NOT EXISTS eb_games_event ON eb_games (event_id)`;
  await sql`CREATE TABLE IF NOT EXISTS eb_ratings (
    k TEXT PRIMARY KEY,
    display TEXT,
    r DOUBLE PRECISION NOT NULL DEFAULT 0,
    n INT NOT NULL DEFAULT 0,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  ready = true;
}

/** Today's upcoming eBasketball card with winner prices. */
export async function fetchEBCard() {
  const out = [];
  const seen = new Set();
  let read = 0;
  for (let page = 1; page <= 4; page++) {
    const data = await getJson("pcUpcomingEvents", {
      sportId: SPORT, marketId: "219", option: "2", timeline: "48",
      pageSize: "100", pageNum: String(page),
    });
    let count = 0;
    for (const t of data?.tournaments || []) {
      for (const ev of t.events || []) {
        count++;
        const g = normaliseEB(ev, t.name);
        if (!g || seen.has(g.id)) continue;
        seen.add(g.id);
        out.push(g);
      }
    }
    read += count;
    if (!count || read >= Number(data?.totalNum || 0)) break;
  }
  return out;
}

/** Bank the card. A price is only taken while the game has not started, so the
 *  stored price is one that could have been backed. */
export async function storeEB(games) {
  await ensure();
  const now = Date.now();
  await Promise.all((games || []).map((g) => {
    const open = g.start && g.start > now;
    const wh = open ? g.win?.home ?? null : null;
    const wa = open ? g.win?.away ?? null : null;
    return sql`
      INSERT INTO eb_games (match_id, event_id, home, away, tourn, start_at, status, win_home, win_away)
      VALUES (${g.id}, ${g.eventId}, ${g.home}, ${g.away}, ${g.tourn}, ${g.start}, ${g.status}, ${wh}, ${wa})
      ON CONFLICT (match_id) DO UPDATE SET
        event_id = COALESCE(EXCLUDED.event_id, eb_games.event_id),
        status = EXCLUDED.status,
        start_at = COALESCE(EXCLUDED.start_at, eb_games.start_at),
        win_home = COALESCE(EXCLUDED.win_home, eb_games.win_home),
        win_away = COALESCE(EXCLUDED.win_away, eb_games.win_away),
        last_seen = now()`;
  }));
  return (games || []).length;
}

/** Pull finished scores for the last few hours and settle banked games. */
export async function settleEB(hours = 6) {
  await ensure();
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  const found = [];
  let read = 0;
  for (let page = 1; page <= 10; page++) {
    let data;
    try {
      data = await getJson("eventResultList", {
        sportId: SPORT, startTime: String(start), endTime: String(end),
        pageSize: "100", pageNum: String(page),
      });
    } catch { break; }
    let count = 0;
    for (const t of data?.tournaments || []) {
      for (const ev of t.events || []) {
        count++;
        const s = finalScore(ev);
        if (s && ev.gameId) found.push([String(ev.gameId), s.home, s.away, String(ev.eventId || "")]);
      }
    }
    // Pages hold "up to" 100 and the first often holds 99, so a short page is
    // not the last one: stop on an empty page or once totalNum is read.
    read += count;
    if (!count || read >= Number(data?.totalNum || 0)) break;
  }
  if (!found.length) return { settled: 0 };
  const rows = await sql`
    UPDATE eb_games t SET r_home = v.h, r_away = v.a, settled_at = now()
    FROM (SELECT unnest(${found.map((x) => x[0])}::text[]) AS id,
                 unnest(${found.map((x) => x[1])}::int[]) AS h,
                 unnest(${found.map((x) => x[2])}::int[]) AS a,
                 unnest(${found.map((x) => x[3])}::text[]) AS ev) v
    WHERE (t.match_id = v.id OR (v.ev <> '' AND t.event_id = v.ev)) AND t.r_home IS NULL
    RETURNING t.match_id`;
  return { settled: rows.length };
}

async function loadRatings(keys) {
  const list = [...new Set(keys)].filter(Boolean);
  const map = new Map();
  if (!list.length) return map;
  const rows = await sql`SELECT k, display, r, n FROM eb_ratings WHERE k = ANY(${list})`;
  for (const r of rows) map.set(r.k, { k: r.k, display: r.display, r: Number(r.r) || 0, n: r.n || 0 });
  return map;
}

/** Train finished games oldest first. Before each one is learned, write down
 *  the % the card would have shown for it. */
export async function trainEB(limit = 1500) {
  await ensure();
  const games = await sql`
    SELECT match_id, home, away, tourn, win_home, win_away, r_home, r_away
    FROM eb_games
    WHERE r_home IS NOT NULL AND trained IS NOT TRUE
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  if (!games.length) return { trained: 0 };
  const ratings = await loadRatings(games.flatMap((g) => [gamerKey(g.home, g.tourn), gamerKey(g.away, g.tourn)]));
  const R = (k, name) => {
    let p = ratings.get(k);
    if (!p) { p = { k, display: splitName(name).gamer || name, r: 0, n: 0 }; ratings.set(k, p); }
    p.dirty = true;
    return p;
  };
  const pre = [];
  for (const g of games) {
    const kH = gamerKey(g.home, g.tourn), kA = gamerKey(g.away, g.tourn);
    const book = bookHome(g.win_home, g.win_away);
    if (book == null || kH === kA) continue;    // no backable price: nothing to learn against
    const H = R(kH, g.home), A = R(kA, g.away);
    pre.push([g.match_id, predict(book, H, A), H.n, A.n]);
    learn(book, H, A, Number(g.r_home) > Number(g.r_away));
  }
  const dirty = [...ratings.values()].filter((p) => p.dirty);
  for (let i = 0; i < dirty.length; i += 25) {
    await Promise.all(dirty.slice(i, i + 25).map((p) => sql`
      INSERT INTO eb_ratings (k, display, r, n, updated) VALUES (${p.k}, ${p.display}, ${p.r}, ${p.n}, now())
      ON CONFLICT (k) DO UPDATE SET r = EXCLUDED.r, n = EXCLUDED.n, updated = now()`));
  }
  for (let i = 0; i < pre.length; i += 200) {
    const part = pre.slice(i, i + 200);
    await sql`UPDATE eb_games t SET pre_home = v.p, pre_nh = v.nh, pre_na = v.na
      FROM (SELECT unnest(${part.map((x) => x[0])}::text[]) AS id,
                   unnest(${part.map((x) => x[1])}::float8[]) AS p,
                   unnest(${part.map((x) => x[2])}::int[]) AS nh,
                   unnest(${part.map((x) => x[3])}::int[]) AS na) v
      WHERE t.match_id = v.id`;
  }
  const ids = games.map((g) => g.match_id);
  for (let i = 0; i < ids.length; i += 200) {
    await sql`UPDATE eb_games SET trained = TRUE WHERE match_id = ANY(${ids.slice(i, i + 200)})`;
  }
  return { trained: games.length, graded: pre.length };
}

/** Grade every game that carries a pre-result %. */
export async function recordEB() {
  await ensure();
  const rows = await sql`
    SELECT pre_home, pre_nh, pre_na, win_home, win_away, r_home, r_away
    FROM eb_games WHERE pre_home IS NOT NULL AND r_home IS NOT NULL`;
  return grade(rows.map((r) => ({
    pre: Number(r.pre_home), nH: r.pre_nh, nA: r.pre_na,
    win: { home: Number(r.win_home), away: Number(r.win_away) },
    res: { home: r.r_home, away: r.r_away },
  })));
}

/** Upcoming games with our % and the paper pick attached. Picks only show
 *  once the record is proven; before that they are marked as watch-only. */
export async function listEB(proven) {
  await ensure();
  const now = Date.now();
  const rows = await sql`
    SELECT match_id, event_id, home, away, tourn, start_at, win_home, win_away
    FROM eb_games WHERE start_at > ${now} AND win_home IS NOT NULL
    ORDER BY start_at ASC LIMIT 200`;
  const ratings = await loadRatings(rows.flatMap((g) => [gamerKey(g.home, g.tourn), gamerKey(g.away, g.tourn)]));
  return rows.map((g) => {
    const H = ratings.get(gamerKey(g.home, g.tourn)) || { r: 0, n: 0 };
    const A = ratings.get(gamerKey(g.away, g.tourn)) || { r: 0, n: 0 };
    const win = { home: Number(g.win_home), away: Number(g.win_away) };
    const book = bookHome(win.home, win.away);
    const ours = predict(book, H, A);
    const pick = pickOf(ours, book, win, H.n, A.n);
    return {
      id: g.match_id, eventId: g.event_id || null, home: g.home, away: g.away, tourn: g.tourn,
      start: Number(g.start_at), win,
      book: book == null ? null : Math.round(book * 1000) / 10,
      ours: ours == null ? null : Math.round(ours * 1000) / 10,
      nH: H.n, nA: A.n,
      pick: pick ? { ...pick, live: !!proven } : null,
    };
  });
}

export async function countsEB() {
  await ensure();
  const r = await sql`SELECT count(*)::int AS total,
    count(r_home)::int AS settled, count(pre_home)::int AS graded,
    (SELECT count(*)::int FROM eb_ratings) AS gamers FROM eb_games`;
  return r[0] || { total: 0, settled: 0, graded: 0, gamers: 0 };
}

/** One full pass: card, results, train. What the poll and the page both run. */
export async function refreshEB() {
  const out = {};
  try { out.saved = await storeEB(await fetchEBCard()); } catch (e) { out.cardErr = String(e?.message || e); }
  try { out.settled = (await settleEB(24)).settled; } catch (e) { out.settleErr = String(e?.message || e); }
  try { Object.assign(out, await trainEB()); } catch (e) { out.trainErr = String(e?.message || e); }
  return out;
}
