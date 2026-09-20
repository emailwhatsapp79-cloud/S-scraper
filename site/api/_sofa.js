// SofaScore history for table tennis. Unofficial JSON — search a SportyBet
// name, pull last ~100 finished matches, bank them as sofa:{id} rows so Elo
// / H2H / last-20 see them. Does not touch odds or the upcoming card.
import { sql } from "./_db.js";

const SOFA = "https://www.sofascore.com/api/v1";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const STALE_MS = 18 * 60 * 60 * 1000;

function nameKey(s) {
  return String(s || "").trim().toUpperCase().replace(/\s+/g, " ");
}

function lastName(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  if (t.includes(",")) return t.split(",")[0].trim().toUpperCase();
  const p = t.split(/\s+/);
  return p[p.length - 1].replace(/\.$/, "").toUpperCase();
}

function searchQueries(name) {
  const t = String(name || "").trim();
  const m = t.match(/^([^,]+),\s*(.+)$/);
  const out = [];
  if (m) {
    out.push(m[2] + " " + m[1]);
    out.push(m[1] + " " + m[2]);
    out.push(m[1]);
  } else out.push(t);
  return [...new Set(out.filter(Boolean))];
}

let ready = false;
async function ensureSofa() {
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
  await sql`CREATE TABLE IF NOT EXISTS tt_sofa_players (
    name_key TEXT PRIMARY KEY,
    sofa_id INT NOT NULL,
    sofa_name TEXT,
    display TEXT,
    pulled_at TIMESTAMPTZ
  )`;
  ready = true;
}

async function sofaGet(path) {
  const r = await fetch(SOFA + path, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Referer: "https://www.sofascore.com/",
    },
  });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`sofa HTTP ${r.status}`);
  return r.json();
}

function pickEntity(results) {
  const list = Array.isArray(results) ? results : [];
  for (const row of list) {
    const e = row.entity || row;
    const sport = e.sport || {};
    const slug = String(sport.slug || sport.name || "").toLowerCase();
    if (slug.includes("table") || sport.id === 20) return e;
  }
  return null;
}

async function searchSofa(name) {
  for (const q of searchQueries(name)) {
    const data = await sofaGet("/search/all?q=" + encodeURIComponent(q));
    if (!data) continue;
    const results = data.results || data;
    const e = pickEntity(results);
    if (e && e.id) return { id: Number(e.id), name: e.name || name };
  }
  return null;
}

async function mapOfKnown() {
  const rows = await sql`SELECT name_key, sofa_id, display FROM tt_sofa_players`;
  const byId = new Map();
  const byKey = new Map();
  const byLast = new Map();
  for (const r of rows) {
    byId.set(Number(r.sofa_id), r.display || r.name_key);
    byKey.set(r.name_key, r);
    const ln = lastName(r.display || r.name_key);
    if (ln) {
      const arr = byLast.get(ln) || [];
      arr.push(r.display || r.name_key);
      byLast.set(ln, arr);
    }
  }
  return { byId, byKey, byLast };
}

function resolveName(team, maps, fallbackDisplay) {
  if (!team) return "Unknown";
  const id = Number(team.id);
  if (id && maps.byId.has(id)) return maps.byId.get(id);
  const ln = lastName(team.name);
  const hits = ln ? maps.byLast.get(ln) : null;
  if (hits && hits.length === 1) return hits[0];
  return fallbackDisplay && nameKey(fallbackDisplay) === nameKey(team.name)
    ? fallbackDisplay
    : (team.name || "Unknown");
}

function finishedScore(ev) {
  const st = String(ev?.status?.type || ev?.status?.description || "");
  if (!/finish|ended|closed/i.test(st)) return null;
  const h = ev.homeScore?.current ?? ev.homeScore?.display;
  const a = ev.awayScore?.current ?? ev.awayScore?.display;
  if (h == null || a == null || !Number.isFinite(Number(h)) || !Number.isFinite(Number(a))) return null;
  return { home: Number(h), away: Number(a) };
}

async function pullPlayerPages(sofaId, pages, maps, display) {
  let saved = 0;
  for (let page = 0; page < pages; page++) {
    const data = await sofaGet(`/team/${sofaId}/events/last/${page}`);
    const events = data?.events || [];
    if (!events.length) break;
    for (const ev of events) {
      const score = finishedScore(ev);
      if (!score || !ev.id) continue;
      const home = resolveName(ev.homeTeam, maps, display);
      const away = resolveName(ev.awayTeam, maps, display);
      const start = ev.startTimestamp ? Number(ev.startTimestamp) * 1000 : null;
      const tourn = ev.tournament?.name || ev.uniqueTournament?.name || "";
      const id = "sofa:" + ev.id;
      await sql`
        INSERT INTO tt_games (
          match_id, event_id, home, away, tourn, start_at, status,
          r_home, r_away, r_status, settled_at
        )
        VALUES (
          ${id}, ${null}, ${home}, ${away}, ${tourn}, ${start}, ${"ended"},
          ${score.home}, ${score.away}, ${"ended"}, ${new Date().toISOString()}
        )
        ON CONFLICT (match_id) DO UPDATE SET
          r_home = COALESCE(EXCLUDED.r_home, tt_games.r_home),
          r_away = COALESCE(EXCLUDED.r_away, tt_games.r_away),
          r_status = COALESCE(EXCLUDED.r_status, tt_games.r_status),
          last_seen = now()`;
      saved++;
    }
    if (data && data.hasNextPage === false) break;
  }
  return saved;
}

async function dueNames(names, limit) {
  await ensureSofa();
  const uniq = [];
  const seen = new Set();
  for (const n of names || []) {
    const k = nameKey(n);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    uniq.push(String(n).trim());
  }
  const rows = await sql`SELECT name_key, pulled_at FROM tt_sofa_players`;
  const pulled = new Map(rows.map((r) => [r.name_key, r.pulled_at]));
  const now = Date.now();
  const due = [];
  for (const n of uniq) {
    const at = pulled.get(nameKey(n));
    if (at && now - new Date(at).getTime() < STALE_MS) continue;
    due.push(n);
    if (due.length >= limit) break;
  }
  return due;
}

/** Bounded: a few names, a few pages. Safe on a page load and on the poll. */
export async function pullSofaHistory(names, opts = {}) {
  const playerLimit = opts.players ?? 4;
  const pages = opts.pages ?? 5;
  await ensureSofa();
  const due = await dueNames(names, playerLimit);
  if (!due.length) return { players: 0, saved: 0 };
  let saved = 0, players = 0, error = null;
  for (const name of due) {
    try {
      let hit = (await sql`SELECT sofa_id, sofa_name FROM tt_sofa_players WHERE name_key = ${nameKey(name)}`)[0];
      if (!hit) {
        const found = await searchSofa(name);
        if (!found) {
          await sql`
            INSERT INTO tt_sofa_players (name_key, sofa_id, sofa_name, display, pulled_at)
            VALUES (${nameKey(name)}, ${0}, ${null}, ${name}, now())
            ON CONFLICT (name_key) DO UPDATE SET pulled_at = now()`;
          continue;
        }
        await sql`
          INSERT INTO tt_sofa_players (name_key, sofa_id, sofa_name, display, pulled_at)
          VALUES (${nameKey(name)}, ${found.id}, ${found.name}, ${name}, now())
          ON CONFLICT (name_key) DO UPDATE SET
            sofa_id = EXCLUDED.sofa_id,
            sofa_name = EXCLUDED.sofa_name,
            display = EXCLUDED.display,
            pulled_at = now()`;
        hit = { sofa_id: found.id, sofa_name: found.name };
      }
      if (!hit.sofa_id) continue;
      const maps = await mapOfKnown();
      saved += await pullPlayerPages(hit.sofa_id, pages, maps, name);
      await sql`UPDATE tt_sofa_players SET pulled_at = now() WHERE name_key = ${nameKey(name)}`;
      players++;
    } catch (e) {
      error = String(e?.message || e);
      break;
    }
  }
  return { players, saved, error };
}
