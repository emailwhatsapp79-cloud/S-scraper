// Real table tennis off SportyBet (sr:sport:20 — TT Cup, TT Elite, Liga Pro…).
// Its own table, its own pipeline; nothing here touches the football code.
// Data-first: read the card, bank players + start + result, add odds/score as
// matches settle. The rating model comes later, once the pile is deep enough.
import { sql } from "./_db.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const SPORT = "sr:sport:20";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";
// 1 = Winner, 238 = Correct Score (set score, best-of-5/7).
const MARKET_IDS = "1,238";

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

// Upcoming card, all TT tournaments, over GET.
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
  return {
    id: String(ev.gameId),
    eventId: ev.eventId || null,
    home: ev.homeTeamName || "?",
    away: ev.awayTeamName || "?",
    tourn: ev._tourn || (ev.sport?.category?.tournament?.name) || "",
    start: ev.estimateStartTime ? Number(ev.estimateStartTime) : null,
    status: ev.matchStatus || "",
  };
}

export async function storeTT(games) {
  await ensureTT();
  if (!games.length) return 0;
  const jobs = games.map((g) => sql`
    INSERT INTO tt_games (match_id, event_id, home, away, tourn, start_at, status)
    VALUES (${g.id}, ${g.eventId}, ${g.home}, ${g.away}, ${g.tourn}, ${g.start}, ${g.status})
    ON CONFLICT (match_id) DO UPDATE SET
      event_id = COALESCE(EXCLUDED.event_id, tt_games.event_id),
      tourn = COALESCE(NULLIF(EXCLUDED.tourn, ''), tt_games.tourn),
      start_at = COALESCE(EXCLUDED.start_at, tt_games.start_at),
      status = EXCLUDED.status,
      last_seen = now()`);
  await Promise.all(jobs);
  return games.length;
}

function csFrom(markets) {
  const win = {}, cs = {};
  for (const m of markets || []) {
    if (m.desc === "Winner") {
      for (const o of m.outcomes || []) {
        const p = parseFloat(o.odds);
        if (isFinite(p)) win[o.desc] = p;
      }
    } else if (m.desc === "Correct Score") {
      for (const o of m.outcomes || []) {
        const p = parseFloat(o.odds);
        if (isFinite(p)) cs[o.desc] = p;
      }
    }
  }
  return { win, cs };
}

function parseSet(s) {
  const m = String(s || "").trim().match(/^(\d+)\s*[:\-]\s*(\d+)$/);
  if (!m) return null;
  return { home: Number(m[1]), away: Number(m[2]) };
}

// Fetch the event to capture odds (pre-match) and the final set score (once ended).
async function fetchEvent(eventId) {
  if (!eventId) return null;
  // The event endpoint returns no markets for TT when marketId is set — ask for
  // the whole event and pick Winner / Correct Score out of it.
  try { return await getJson("event", { eventId, productId: "3" }); }
  catch { return null; }
}

/** Bounded pass: fill missing odds on upcoming rows, and settle ended ones. */
export async function enrichSettleTT(limit = 30) {
  await ensureTT();
  const now = Date.now();
  const due = await sql`
    SELECT match_id, event_id, start_at, r_status, win_home
    FROM tt_games
    WHERE event_id IS NOT NULL
      AND (
        (r_status IS NULL AND start_at IS NOT NULL AND start_at < ${now - 90000})
        OR (win_home IS NULL AND start_at IS NOT NULL AND start_at > ${now - 90000})
      )
    ORDER BY start_at ASC
    LIMIT ${limit}`;
  if (!due.length) return { touched: 0 };
  const evs = await Promise.all(due.map((r) => fetchEvent(r.event_id)));
  let touched = 0;
  for (let i = 0; i < due.length; i++) {
    const ev = evs[i];
    if (!ev) continue;
    const { win, cs } = csFrom(ev.markets);
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

function shape(r) {
  let cs = null;
  if (r.cs_json) { try { cs = JSON.parse(r.cs_json); } catch { cs = null; } }
  const start = r.start_at ? Number(r.start_at) : null;
  return {
    id: r.match_id, eventId: r.event_id || null,
    home: r.home, away: r.away, tourn: r.tourn || "",
    start, status: r.status || "",
    upcoming: isUpcomingTT(r.status, start),
    win: (r.win_home != null || r.win_away != null) ? { home: r.win_home, away: r.win_away } : null,
    cs,
    res: r.r_home == null ? null : { home: r.r_home, away: r.r_away },
  };
}

export async function listUpcomingTT(limit = 400) {
  await ensureTT();
  const cutoff = Date.now() - 2 * 60 * 1000;
  const rows = await sql`
    SELECT * FROM tt_games
    WHERE start_at IS NULL OR start_at > ${cutoff}
    ORDER BY start_at ASC NULLS LAST
    LIMIT ${limit}`;
  return rows.map(shape).filter((g) => g.upcoming);
}

export async function countsTT() {
  await ensureTT();
  const rows = await sql`
    SELECT
      COUNT(*) AS total,
      COUNT(*) FILTER (WHERE r_status IS NOT NULL) AS settled,
      COUNT(DISTINCT home) + COUNT(DISTINCT away) AS names
    FROM tt_games`;
  const r = rows[0] || {};
  return { total: Number(r.total || 0), settled: Number(r.settled || 0) };
}
