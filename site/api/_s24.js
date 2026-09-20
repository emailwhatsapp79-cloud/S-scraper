// scores24.live rapi — finished TT grind (Elite / Cup / Liga Pro / Setka).
// Banks set scores as s24:{id} into tt_games so Elo / H2H / last-20 fill now.
import { sql } from "./_db.js";

const BASE = "https://scores24.live/rapi";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const LEAGUES = [
  "tt-elite-series-1",
  "tt-cup-1",
  "czech-liga-pro-1",
  "setka-cup-1",
];

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

function byLastMap(names) {
  const m = new Map();
  for (const n of names || []) {
    const ln = lastName(n);
    if (!ln) continue;
    const arr = m.get(ln) || [];
    if (!arr.some((x) => nameKey(x) === nameKey(n))) arr.push(n);
    m.set(ln, arr);
  }
  return m;
}

function canon(name, byLast) {
  const hits = byLast.get(lastName(name));
  if (hits && hits.length === 1) return hits[0];
  return name;
}

function pad(n) { return String(n).padStart(2, "0"); }
function stamp(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
    " " + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds());
}

function parseSets(s) {
  const m = String(s || "").trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  const home = Number(m[1]), away = Number(m[2]);
  if (!Number.isFinite(home) || !Number.isFinite(away)) return null;
  if (home === 0 && away === 0) return null;
  if (Math.max(home, away) < 3) return null;
  return { home, away };
}

let ready = false;
async function ensure() {
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

async function rapi(path, query) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null && v !== "") q.set(k, String(v));
  }
  const r = await fetch(BASE + path + "?" + q, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json",
      Origin: "https://scores24.live",
      Referer: "https://scores24.live/en/table-tennis",
    },
  });
  if (!r.ok) throw new Error("s24 HTTP " + r.status);
  return r.json();
}

async function pullLeague(slug, from, to, pages, first, byLast) {
  let after = "", saved = 0, seen = 0;
  for (let p = 0; p < pages; p++) {
    const data = await rapi("/leagues/table-tennis/" + slug + "/matches", {
      lang: "en",
      first: String(first),
      status: "ended",
      "date_between[]": [from, to],
      with_statistics: "false",
      audience: "en",
      ...(after ? { after } : {}),
    });
    const edges = data?.data?.edges || [];
    if (!edges.length) break;
    for (const e of edges) {
      const n = e.node || {};
      if (n.is_finished === false) continue;
      const score = parseSets(n.result_score);
      if (!score || !n.id) continue;
      const teams = n.teams || [];
      if (teams.length < 2) continue;
      const home = canon(teams[0].name, byLast);
      const away = canon(teams[1].name, byLast);
      const start = n.match_date ? Date.parse(n.match_date) : null;
      const tourn = n.unique_tournament?.name || n.league_slug || slug;
      const id = "s24:" + n.id;
      seen++;
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
    const info = data?.data?.pageInfo || {};
    if (!info.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return { seen, saved };
}

/** Bounded pull. Page load: 1 page × 4 leagues. Poll: more pages, longer window. */
export async function pullScores24(names, opts = {}) {
  await ensure();
  const pages = opts.pages ?? 1;
  const first = opts.first ?? 50;
  const days = opts.days ?? 7;
  const now = Date.now();
  const from = stamp(now - days * 24 * 3600 * 1000);
  const to = stamp(now + 2 * 3600 * 1000);
  const byLast = byLastMap(names);
  let saved = 0, seen = 0, error = null;
  for (const slug of LEAGUES) {
    try {
      const r = await pullLeague(slug, from, to, pages, first, byLast);
      saved += r.saved;
      seen += r.seen;
    } catch (e) {
      error = String(e?.message || e);
      break;
    }
  }
  return { saved, seen, error };
}
