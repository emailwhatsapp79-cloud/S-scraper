// Tennis match history off SportyBet's own results (sr:sport:5): the same
// players and events the card offers. Singles only. Feeds the tennis stats
// model the way tt_games feeds table tennis.
import { sql } from "./_db.js";

const BASE = "https://www.sportybet.com/api/ng/factsCenter";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

let ready = false;
export async function ensureTnHist() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS tn_games (
    match_id TEXT PRIMARY KEY,
    event_id TEXT,
    home TEXT, away TEXT,
    tourn TEXT,
    start_at BIGINT,
    r_home INT, r_away INT,
    games TEXT,
    pre_stats DOUBLE PRECISION,
    trained BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  await sql`CREATE INDEX IF NOT EXISTS tn_games_untrained ON tn_games (start_at) WHERE trained IS NOT TRUE`;
  ready = true;
}

/** Doubles ("A / B"), walkovers and unfinished rows are dropped. */
export function rowFromResult(ev, tourn) {
  if (!ev || !ev.gameId || !ev.homeTeamName || !ev.awayTeamName) return null;
  if (!/^end/i.test(String(ev.matchStatus || ""))) return null;
  const t = String(tourn || "");
  if (/doubles/i.test(t) || /\//.test(ev.homeTeamName + ev.awayTeamName)) return null;
  const m = String(ev.setScore || "").match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  if (h === a || Math.max(h, a) < 2) return null;
  const games = Array.isArray(ev.gameScore) ? ev.gameScore.filter((x) => /^\d+:\d+$/.test(String(x))) : [];
  if (games.length < 2) return null;  // retirements after a set still count; 1-set stubs do not
  return {
    id: "sb:" + String(ev.gameId) + ":" + String(ev.estimateStartTime || ""),
    eventId: String(ev.eventId || ""),
    home: ev.homeTeamName, away: ev.awayTeamName, tourn: t,
    start: Number(ev.estimateStartTime) || null,
    r_home: h, r_away: a, games: games.join(" "),
  };
}

export function rowsFromPage(data) {
  const out = [];
  for (const t of data?.tournaments || []) {
    for (const ev of t.events || []) {
      const r = rowFromResult(ev, t.name);
      if (r && r.start) out.push(r);
    }
  }
  return out;
}

export async function saveTnRows(rows) {
  await ensureTnHist();
  const list = [...new Map((rows || []).map((r) => [r.id, r])).values()];
  for (let i = 0; i < list.length; i += 300) {
    const p = list.slice(i, i + 300);
    await sql`
      INSERT INTO tn_games (match_id, event_id, home, away, tourn, start_at, r_home, r_away, games)
      SELECT * FROM unnest(
        ${p.map((r) => r.id)}::text[], ${p.map((r) => r.eventId)}::text[],
        ${p.map((r) => r.home)}::text[], ${p.map((r) => r.away)}::text[],
        ${p.map((r) => r.tourn)}::text[], ${p.map((r) => r.start)}::bigint[],
        ${p.map((r) => r.r_home)}::int[], ${p.map((r) => r.r_away)}::int[],
        ${p.map((r) => r.games)}::text[])
      ON CONFLICT (match_id) DO NOTHING`;
  }
  return list.length;
}

async function getJson(params, timeoutMs = 8000) {
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/eventResultList?${new URLSearchParams(params)}`, {
      headers: { "User-Agent": UA, Accept: "application/json" }, signal: ac.signal,
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    if (body.bizCode !== 10000) throw new Error(`bizCode ${body.bizCode}`);
    return body.data;
  } finally { clearTimeout(to); }
}

/** Newest finished singles off SportyBet, saved. What the timer runs. */
export async function pullTnResults(hours = 3, maxPages = 10) {
  const end = Date.now();
  const start = end - hours * 3600 * 1000;
  const rows = [];
  let read = 0;
  for (let page = 1; page <= maxPages; page++) {
    let data;
    try {
      data = await getJson({ sportId: "sr:sport:5", startTime: String(start), endTime: String(end), pageSize: "100", pageNum: String(page) });
    } catch { break; }
    const n = (data?.tournaments || []).reduce((s, t) => s + (t.events || []).length, 0);
    rows.push(...rowsFromPage(data));
    read += n;
    if (!n || read >= Number(data?.totalNum || 0)) break;
  }
  return { read, saved: await saveTnRows(rows) };
}
