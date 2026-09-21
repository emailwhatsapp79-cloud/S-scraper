// Official Setka Cup feed — tabletennis.setkacup.com (free JSON, no auth, not
// bot-walled). This is the ONE source that carries the Moldova/other Setka pools
// scores24 doesn't. Per card player: find their Setka id, walk their recent
// tournaments, bank every finished match as setka:{id}. Because everyone in a
// pool plays the same tournaments, a few players fill the whole pool fast.
import { sql } from "./_db.js";
import { bulkInsert } from "./_s24.js";

const API = "https://tabletennis.setkacup.com/api";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const STALE_MS = 12 * 60 * 60 * 1000;

function foldToken(t) {
  return t.replace(/SKYI$/g, "SKI").replace(/SKIY$/g, "SKI").replace(/SKII$/g, "SKI")
    .replace(/SKYJ$/g, "SKI").replace(/YI$/g, "I").replace(/IY$/g, "I");
}
// Same folding rule the model uses, so a Setka name and the SportyBet card name
// collapse to one key.
function nameKey(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z]+/g, " ").trim()
    .split(/\s+/).filter((t) => t.length > 1).map(foldToken).sort().join("|");
}
function lastName(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.includes(",")) return t.split(",")[0].trim();
  const p = t.split(/\s+/);
  return p[p.length - 1];
}

async function timedFetch(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/json", Referer: "https://tabletennis.setkacup.com/" },
      signal: ac.signal,
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(to); }
}

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS tt_setka_players (
    name_key TEXT PRIMARY KEY,
    player_id INT,
    display TEXT,
    rating DOUBLE PRECISION,
    pulled_at TIMESTAMPTZ
  )`;
  ready = true;
}

// Find a card player's Setka id via the name filter, matching on our fold key.
async function findPlayer(name) {
  const ln = lastName(name);
  if (!ln) return null;
  const key = nameKey(name);
  let data;
  try { data = await timedFetch(`${API}/Players/en/paged?filter=${encodeURIComponent(ln)}&count=30&page=1`); }
  catch { return null; }
  const groups = (data && data.players) || {};
  const list = [];
  for (const arr of Object.values(groups)) for (const p of arr) list.push(p);
  // exact fold match first, else a lone same-surname hit
  let hit = list.find((p) => nameKey(p.firstName + " " + p.lastName) === key);
  if (!hit) {
    const same = list.filter((p) => nameKey(p.lastName) && key.includes(nameKey(p.lastName).split("|")[0]));
    if (same.length === 1) hit = same[0];
  }
  if (!hit || !hit.id) return null;
  return { id: hit.id, display: hit.lastName + ", " + hit.firstName, rating: hit.ratingSc ?? null };
}

// Recent tournament ids a player appeared in (newest first).
async function recentTournaments(id, limit) {
  let d;
  try { d = await timedFetch(`${API}/Players/en/${id}`); }
  catch { return []; }
  const stats = (d && d.tournamentStats) || [];
  return stats
    .filter((t) => t && t.id && t.startDate && Date.parse(t.startDate) <= Date.now())
    .sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate))
    .slice(0, limit)
    .map((t) => t.id);
}

function matchRow(m) {
  if (!m || m.statusId !== 3) return null; // 3 = finished
  const p1 = m.player1, p2 = m.player2;
  if (!p1 || !p2) return null;
  const h = Number(m.player1Score), a = Number(m.player2Score);
  if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
  if (Math.max(h, a) < 3 || h === a) return null;       // real best-of-5 result only
  if (m.technicalResult) return null;                    // skip walkovers
  const start = m.startDate ? Date.parse(m.startDate) : null;
  return {
    id: "setka:" + m.id,
    home: p1.lastName + ", " + p1.firstName,
    away: p2.lastName + ", " + p2.firstName,
    tourn: "Setka Cup",
    start: Number.isFinite(start) ? start : null,
    r_home: h, r_away: a,
  };
}

async function tournamentRows(tid) {
  let arr;
  try { arr = await timedFetch(`${API}/Matches/en?tournamentId=${tid}`); }
  catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const m of arr) { const r = matchRow(m); if (r) out.push(r); }
  return out;
}

/** Bounded pull for a set of names (the card). Fills a pool fast because pool
 *  members share tournaments. deadlineMs caps wall time. */
export async function pullSetka(names, opts = {}) {
  await ensure();
  const players = opts.players ?? 6;
  const tourns = opts.tournaments ?? 8;
  const deadline = Date.now() + (opts.deadlineMs || 15000);

  // de-dupe names, keep those not pulled recently
  const uniq = [];
  const seenN = new Set();
  for (const n of names || []) {
    const k = nameKey(n);
    if (!k || seenN.has(k)) continue;
    seenN.add(k);
    uniq.push(String(n).trim());
  }
  const cached = await sql`SELECT name_key, player_id, pulled_at FROM tt_setka_players`;
  const cache = new Map(cached.map((r) => [r.name_key, r]));
  const now = Date.now();
  const due = uniq.filter((n) => {
    const c = cache.get(nameKey(n));
    return !c || !c.pulled_at || now - new Date(c.pulled_at).getTime() > STALE_MS;
  }).slice(0, players);
  if (!due.length) return { players: 0, saved: 0, note: "none due" };

  const rows = [];
  const seenTid = new Set();
  let used = 0, found = 0;
  for (const name of due) {
    if (Date.now() > deadline) break;
    const c = cache.get(nameKey(name));
    let id = c && c.player_id;
    if (id == null) {
      const p = await findPlayer(name);
      if (p) {
        id = p.id; found++;
        await sql`INSERT INTO tt_setka_players (name_key, player_id, display, rating, pulled_at)
          VALUES (${nameKey(name)}, ${p.id}, ${p.display}, ${p.rating}, now())
          ON CONFLICT (name_key) DO UPDATE SET player_id = ${p.id}, display = ${p.display}, rating = ${p.rating}, pulled_at = now()`;
      } else {
        await sql`INSERT INTO tt_setka_players (name_key, player_id, display, pulled_at)
          VALUES (${nameKey(name)}, ${null}, ${name}, now())
          ON CONFLICT (name_key) DO UPDATE SET pulled_at = now()`;
        continue;
      }
    }
    if (!id) continue;
    const tids = await recentTournaments(id, tourns);
    for (const tid of tids) {
      if (Date.now() > deadline) break;
      if (seenTid.has(tid)) continue;
      seenTid.add(tid);
      const rs = await tournamentRows(tid);
      for (const r of rs) rows.push(r);
    }
    await sql`UPDATE tt_setka_players SET pulled_at = now() WHERE name_key = ${nameKey(name)}`;
    used++;
  }

  // de-dupe within this pass
  const seen = new Set();
  const uniqRows = [];
  for (const r of rows) { if (seen.has(r.id)) continue; seen.add(r.id); uniqRows.push(r); }
  const saved = uniqRows.length ? await bulkInsert(uniqRows) : 0;
  return { players: used, found, saved, note: `setka ${used}p/${saved}` };
}

function ymd(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

let toursReady = false;
async function ensureTours() {
  if (toursReady) return;
  await sql`CREATE TABLE IF NOT EXISTS tt_setka_tourn (
    tid INT PRIMARY KEY,
    done BOOLEAN NOT NULL DEFAULT FALSE,
    pulled_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  toursReady = true;
}

/** Whole-firehose sweep: the Tournaments-by-date endpoint already embeds every
 *  tournament's matches, so ONE (slow, ~13s, ~450KB) fetch per day yields all
 *  pools at once — Ukraine, Moldova, global. A day whose date is already past is
 *  swept once and marked done; today is re-swept until it closes. deadlineMs
 *  bounds it (usually ~1 day per pass given the payload size). */
export async function pullSetkaDays(opts = {}) {
  await ensure();
  await ensureTours();
  const days = opts.days ?? 1;
  const offset = opts.offset ?? 0; // start this many days back — lets a backfill walk older
  const deadline = Date.now() + (opts.deadlineMs || 20000);
  const today = ymd(Date.now());

  const doneRows = await sql`SELECT tid FROM tt_setka_tourn WHERE done = TRUE`;
  const done = new Set(doneRows.map((r) => Number(r.tid)));

  const rows = [];
  const seen = new Set();
  const marks = [];
  let daysHit = 0, tournsPulled = 0, err = null;
  for (let d = offset; d < offset + days; d++) {
    if (Date.now() > deadline) break;
    const date = ymd(Date.now() - d * 24 * 3600 * 1000);
    let list;
    // Big payload — give it room (the default 8s cut it off on Vercel).
    try { list = await timedFetch(`${API}/Tournaments/en?date=${date}`, 16000); }
    catch (e) { err = err || String(e?.message || e); continue; }
    if (!Array.isArray(list)) continue;
    daysHit++;
    const isPast = date < today;
    for (const t of list) {
      const tid = Number(t.id);
      if (!tid || done.has(tid)) continue;
      if (/women|double|xd/i.test(String(t.divisionToken || t.name || ""))) continue;
      for (const m of t.matches || []) {
        const r = matchRow(m);
        if (r && !seen.has(r.id)) { seen.add(r.id); rows.push(r); }
      }
      tournsPulled++;
      if (isPast) marks.push(tid); // final — never fetch again
    }
  }
  const saved = rows.length ? await bulkInsert(rows) : 0;
  for (let i = 0; i < marks.length; i += 100) {
    const chunk = marks.slice(i, i + 100);
    await sql`INSERT INTO tt_setka_tourn (tid, done)
      SELECT unnest(${chunk}::int[]), TRUE
      ON CONFLICT (tid) DO UPDATE SET done = TRUE, pulled_at = now()`;
  }
  return { daysHit, tournsPulled, saved, err, note: `setka sweep ${tournsPulled}t/${saved}` };
}
