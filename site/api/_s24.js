// scores24.live — bank finished TT grind into tt_games (s24:{id}).
// 1) One HTML dump of /en/table-tennis (SSR JSON, ~600 ended games).
// 2) rapi pages if HTML was thin. Never throw away a league on one error.
import { sql } from "./_db.js";

const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
const HDR = {
  "User-Agent": UA,
  Accept: "text/html,application/json",
  Origin: "https://scores24.live",
  Referer: "https://scores24.live/en/table-tennis",
};
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

function rowFromNode(n, tourn, byLast) {
  if (!n || !n.id) return null;
  const finished = n.isFinished === true || n.is_finished === true ||
    (n.status && Number(n.status.code) === 100);
  if (!finished && n.isFinished === false) return null;
  const score = parseSets(n.resultScore || n.result_score);
  if (!score) return null;
  const teams = n.teams || [];
  if (teams.length < 2) return null;
  const startRaw = n.matchDate || n.match_date;
  const start = startRaw ? Date.parse(startRaw) : null;
  return {
    id: "s24:" + n.id,
    home: canon(teams[0].name, byLast),
    away: canon(teams[1].name, byLast),
    tourn: tourn || n.uniqueTournament?.name || n.unique_tournament?.name || n.leagueSlug || n.league_slug || "",
    start: Number.isFinite(start) ? start : null,
    r_home: score.home,
    r_away: score.away,
  };
}

async function bulkInsert(rows) {
  let saved = 0;
  for (let i = 0; i < rows.length; i += 15) {
    const slice = rows.slice(i, i + 15);
    await Promise.all(slice.map((r) => sql`
      INSERT INTO tt_games (
        match_id, event_id, home, away, tourn, start_at, status,
        r_home, r_away, r_status, settled_at
      )
      VALUES (
        ${r.id}, ${null}, ${r.home}, ${r.away}, ${r.tourn}, ${r.start}, ${"ended"},
        ${r.r_home}, ${r.r_away}, ${"ended"}, ${new Date().toISOString()}
      )
      ON CONFLICT (match_id) DO UPDATE SET
        r_home = COALESCE(EXCLUDED.r_home, tt_games.r_home),
        r_away = COALESCE(EXCLUDED.r_away, tt_games.r_away),
        r_status = COALESCE(EXCLUDED.r_status, tt_games.r_status),
        last_seen = now()`));
    saved += slice.length;
  }
  return saved;
}

async function fromHtml(byLast) {
  const r = await fetch("https://scores24.live/en/table-tennis", { headers: HDR });
  if (!r.ok) throw new Error("s24 html HTTP " + r.status);
  const html = await r.text();
  const m = html.match(/window\.__REACT_QUERY_STATE__=JSON\.parse\("([\s\S]*?)"\);/);
  if (!m) throw new Error("s24 html: no state");
  const parsed = JSON.parse(JSON.parse('"' + m[1] + '"'));
  const rows = [];
  const seen = new Set();
  for (const q of parsed.queries || []) {
    const d = q?.state?.data?.data;
    const groups = Array.isArray(d) ? d : [];
    for (const g of groups) {
      const tourn = g?.league?.name || "";
      for (const n of g?.matches || []) {
        const row = rowFromNode(n, tourn, byLast);
        if (!row || seen.has(row.id)) continue;
        seen.add(row.id);
        rows.push(row);
      }
    }
  }
  return rows;
}

async function rapi(path, query) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (Array.isArray(v)) v.forEach((x) => q.append(k, x));
    else if (v != null && v !== "") q.set(k, String(v));
  }
  const r = await fetch("https://scores24.live/rapi" + path + "?" + q, {
    headers: { ...HDR, Accept: "application/json" },
  });
  if (!r.ok) throw new Error("s24 rapi HTTP " + r.status);
  return r.json();
}

async function fromRapi(byLast, pages, first, days) {
  const now = Date.now();
  const from = stamp(now - days * 24 * 3600 * 1000);
  const to = stamp(now + 2 * 3600 * 1000);
  const rows = [];
  const seen = new Set();
  const errors = [];
  for (const slug of LEAGUES) {
    let after = "";
    try {
      for (let p = 0; p < pages; p++) {
        const data = await rapi("/leagues/table-tennis/" + slug + "/matches", {
          lang: "en", first: String(first), status: "ended",
          "date_between[]": [from, to],
          with_statistics: "false", audience: "en",
          ...(after ? { after } : {}),
        });
        const edges = data?.data?.edges || [];
        if (!edges.length) break;
        for (const e of edges) {
          const row = rowFromNode(e.node, slug, byLast);
          if (!row || seen.has(row.id)) continue;
          seen.add(row.id);
          rows.push(row);
        }
        const info = data?.data?.pageInfo || {};
        if (!info.hasNextPage || !info.endCursor) break;
        after = info.endCursor;
      }
    } catch (e) {
      errors.push(slug + ": " + (e?.message || e));
    }
  }
  return { rows, errors };
}

export async function pullScores24(names, opts = {}) {
  await ensure();
  const byLast = byLastMap(names);
  const pages = opts.pages ?? 2;
  const first = opts.first ?? 50;
  const days = opts.days ?? 7;
  const notes = [];
  const all = [];
  const seen = new Set();

  try {
    const htmlRows = await fromHtml(byLast);
    notes.push("html " + htmlRows.length);
    for (const r of htmlRows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      all.push(r);
    }
  } catch (e) {
    notes.push("html " + (e?.message || e));
  }

  if (all.length < 80) {
    try {
      const extra = await fromRapi(byLast, pages, first, days);
      notes.push("rapi " + extra.rows.length);
      if (extra.errors.length) notes.push(extra.errors.join("; "));
      for (const r of extra.rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        all.push(r);
      }
    } catch (e) {
      notes.push("rapi " + (e?.message || e));
    }
  }

  const saved = all.length ? await bulkInsert(all) : 0;
  return { saved, seen: all.length, note: notes.join(" · ") };
}
