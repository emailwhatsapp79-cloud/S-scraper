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
const CORE = [
  "czech-liga-pro-1",
  "tt-elite-series-1",
  "setka-cup-0",
  "international-tt-cup",
  "challenger-series-tt",
];
const LEAGUES = CORE;

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

function fillKey() {
  return process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";
}
function proxyOrigins() {
  const out = [];
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const here = process.env.VERCEL_URL;
  if (prod) out.push("https://" + prod);
  if (here) out.push("https://" + here);
  return [...new Set(out)];
}

async function fetchS24(target, accept) {
  const errors = [];
  for (const origin of proxyOrigins()) {
    try {
      const u = target.includes("/rapi/")
        ? origin + "/api/s24-proxy?kind=rapi&u=" + encodeURIComponent(target)
        : origin + "/api/s24-proxy";
      const r = await fetch(u, { headers: { "x-fill-key": fillKey(), Accept: accept || "*/*" } });
      if (r.ok) return r;
      errors.push("edge " + r.status);
    } catch (e) {
      errors.push("edge " + (e?.message || e));
    }
  }
  const r = await fetch(target, {
    headers: { ...HDR, Accept: accept || HDR.Accept },
  });
  if (!r.ok) throw new Error((errors[0] ? errors[0] + " · " : "") + "direct HTTP " + r.status);
  return r;
}

async function fromHtml(byLast) {
  const r = await fetchS24("https://scores24.live/en/table-tennis", "text/html");
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
  const target = "https://scores24.live/rapi" + path + "?" + q;
  const r = await fetchS24(target, "application/json");
  if (!r.ok) throw new Error("s24 rapi HTTP " + r.status);
  return r.json();
}

async function endedPage(slug, first, from, to, after) {
  return rapi("/leagues/table-tennis/" + slug + "/matches", {
    lang: "en", first: String(first), status: "ended",
    "date_between[]": [from, to],
    with_statistics: "false", audience: "en",
    ...(after ? { after } : {}),
  });
}

function takeRows(edges, slug, byLast, rows) {
  for (const e of edges || []) {
    const row = rowFromNode(e.node, slug, byLast);
    if (row) rows.push(row);
  }
}

async function pullLeague(slug, byLast, pages, first, from, to, deadline) {
  const rows = [];
  const errors = [];
  let hasMore = false;
  const k = "y2|" + slug;
  try {
    const latest = await endedPage(slug, first, from, to, "");
    takeRows(latest?.data?.edges, slug, byLast, rows);
    const latestInfo = latest?.data?.pageInfo || {};

    const st = await sql`SELECT cursor FROM tt_s24_state WHERE k = ${k}`;
    let after = (st[0] && st[0].cursor) || "";
    if (after === "DONE") return { rows, errors, hasMore: false };
    if (!after) after = latestInfo.endCursor || "";
    if (!after) {
      // Missing pageInfo is a bad response, not the end of history.
      errors.push(slug + ": no cursor");
      return { rows, errors, hasMore: true };
    }
    for (let p = 0; p < pages; p++) {
      if (deadline && Date.now() > deadline) {
        hasMore = true;
        break;
      }
      const data = await endedPage(slug, first, from, to, after);
      const edges = data?.data?.edges || [];
      const info = data?.data?.pageInfo || {};
      if (!edges.length && info.hasNextPage === false) {
        await sql`INSERT INTO tt_s24_state (k, cursor) VALUES (${k}, ${"DONE"})
          ON CONFLICT (k) DO UPDATE SET cursor = ${"DONE"}, updated = now()`;
        after = "DONE";
        break;
      }
      if (!edges.length) {
        errors.push(slug + ": empty page");
        hasMore = true;
        break;
      }
      takeRows(edges, slug, byLast, rows);
      if (info.hasNextPage === false) {
        await sql`INSERT INTO tt_s24_state (k, cursor) VALUES (${k}, ${"DONE"})
          ON CONFLICT (k) DO UPDATE SET cursor = ${"DONE"}, updated = now()`;
        after = "DONE";
        break;
      }
      if (!info.endCursor) {
        hasMore = true;
        break;
      }
      after = info.endCursor;
      await sql`INSERT INTO tt_s24_state (k, cursor) VALUES (${k}, ${after})
        ON CONFLICT (k) DO UPDATE SET cursor = ${after}, updated = now()`;
      hasMore = true;
    }
    if (after && after !== "DONE") hasMore = true;
  } catch (e) {
    errors.push(slug + ": " + (e?.message || e));
    hasMore = true;
  }
  return { rows, errors, hasMore };
}

async function listLeagues(from, to) {
  const found = [...CORE];
  try {
    const data = await rapi("/sports/table-tennis/matches", {
      lang: "en", sport: "table-tennis", first: "1", status: "ended",
      "date_between[]": [from, to], audience: "en",
    });
    const groups = Array.isArray(data) ? data : (data?.data || data || []);
    for (const c of groups) {
      for (const lg of c.leagues || []) {
        const slug = lg.slug || lg.league?.slug;
        const name = lg.name || lg.league?.name || "";
        if (!slug) continue;
        if (/^wtt-/i.test(slug) || /xd$/i.test(slug) || /double/i.test(name)) continue;
        found.push(slug);
      }
    }
  } catch { /* CORE still runs */ }
  return [...new Set(found)];
}

async function fromRapi(byLast, pages, first, days) {
  const now = Date.now();
  const from = stamp(now - days * 24 * 3600 * 1000);
  const to = stamp(now + 2 * 3600 * 1000);
  await sql`CREATE TABLE IF NOT EXISTS tt_s24_state (
    k TEXT PRIMARY KEY,
    cursor TEXT,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  const slugs = await listLeagues(from, to);
  const turn = await sql`SELECT cursor FROM tt_s24_state WHERE k = ${"rr"}`;
  let i = Number(turn[0] && turn[0].cursor) || 0;
  if (!Number.isFinite(i) || i < 0) i = 0;
  const slug = slugs[i % slugs.length];
  await sql`INSERT INTO tt_s24_state (k, cursor) VALUES (${"rr"}, ${String(i + 1)})
    ON CONFLICT (k) DO UPDATE SET cursor = ${String(i + 1)}, updated = now()`;
  const deadline = Date.now() + 22000;
  const part = await pullLeague(slug, byLast, pages, first, from, to, deadline);
  const done = await sql`SELECT k FROM tt_s24_state WHERE k LIKE ${"y2|%"} AND cursor = ${"DONE"}`;
  const allDone = done.length >= slugs.length && !part.hasMore;
  return {
    rows: part.rows,
    errors: part.errors || [],
    hasMore: !allDone || part.hasMore,
    slug,
  };
}

function teamSlugs(name) {
  const raw = String(name || "").trim();
  if (!raw) return [];
  const slug = (s) => String(s).toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  let first = "", last = "";
  if (raw.includes(",")) {
    last = raw.split(",")[0].trim();
    first = raw.split(",").slice(1).join(" ").trim();
  } else {
    const p = raw.split(/\s+/);
    first = p[0] || "";
    last = p.slice(1).join(" ");
  }
  const out = [];
  if (first && last) {
    out.push(slug(first) + "-" + slug(last));
    out.push(slug(last) + "-" + slug(first));
  } else if (raw) out.push(slug(raw));
  return [...new Set(out.filter((s) => s.length > 3))];
}

async function fromPlayers(names, byLast, limit, pages) {
  const uniq = [];
  const seenN = new Set();
  for (const n of names || []) {
    const k = nameKey(n);
    if (!k || seenN.has(k)) continue;
    seenN.add(k);
    uniq.push(n);
    if (uniq.length >= limit) break;
  }
  const rows = [];
  const seen = new Set();
  let used = 0;
  for (const name of uniq) {
    for (const slug of teamSlugs(name)) {
      let after = "", any = false;
      try {
        for (let p = 0; p < pages; p++) {
          const data = await rapi("/teams/table-tennis/" + slug + "/matches", {
            lang: "en", first: "20",
            ...(after ? { after } : {}),
          });
          const edges = data?.data?.edges || [];
          if (!edges.length) break;
          any = true;
          for (const e of edges) {
            const n = e.node || {};
            const tourn = n.unique_tournament?.name || n.uniqueTournament?.name || n.league_slug || "";
            const row = rowFromNode(n, tourn, byLast);
            if (!row || seen.has(row.id)) continue;
            seen.add(row.id);
            rows.push(row);
          }
          const info = data?.data?.pageInfo || {};
          if (!info.hasNextPage || !info.endCursor) break;
          after = info.endCursor;
        }
      } catch { /* try the other slug */ }
      if (any) { used++; break; }
    }
  }
  return { rows, used };
}

export async function pullScores24(names, opts = {}) {
  await ensure();
  if (!names.length) {
    const rows = await sql`
      SELECT home, away FROM tt_games
      WHERE start_at IS NULL OR start_at > ${Date.now() - 3600000}
      ORDER BY start_at ASC NULLS LAST
      LIMIT 80`;
    names = rows.flatMap((r) => [r.home, r.away]);
  }
  const byLast = byLastMap(names);
  const pages = opts.pages ?? 2;
  const first = opts.first ?? 50;
  const days = opts.days ?? 400;
  const notes = [];
  const all = [];
  const seen = new Set();
  let hasMore = false;

  if (!opts.skipHtml) {
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
  }

  if (all.length < 80 || opts.more) {
    try {
      const extra = await fromRapi(byLast, pages, first, days);
      notes.push((extra.slug || "rapi") + " " + extra.rows.length + (extra.hasMore ? " more…" : " done"));
      if (extra.hasMore) hasMore = true;
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

  const pLimit = opts.players ?? 0;
  if (pLimit > 0) {
    try {
      const extra = await fromPlayers(names, byLast, pLimit, opts.playerPages ?? 4);
      notes.push("players " + extra.used + "/" + extra.rows.length);
      for (const r of extra.rows) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        all.push(r);
      }
    } catch (e) {
      notes.push("players " + (e?.message || e));
    }
  }

  const saved = all.length ? await bulkInsert(all) : 0;
  return { saved, seen: all.length, note: notes.join(" · "), hasMore };
}
