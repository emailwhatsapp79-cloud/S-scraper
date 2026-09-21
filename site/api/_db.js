// One place for the database handle and the row shape.
import { neon } from "@neondatabase/serverless";
import { isUpcoming } from "./_shape.js";

export const sql = neon(process.env.DATABASE_URL);

export function logErr(where, e) {
  console.error("[vfs]", where, e && (e.stack || e.message || e));
}

function parseCs(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

export const COLUMNS = [
  "game_id", "event_id", "home", "away", "league", "kickoff", "status",
  "ft_home", "ft_draw", "ft_away", "dc_1x", "dc_12", "dc_x2",
  "ht_home", "ht_draw", "ht_away", "cs_json",
];

export function rowToGame(r) {
  // A stored row keeps the status it had when it was last seen, and a game
  // the feeds stop showing is never updated again. So the clock decides:
  // once kick-off has passed it is not upcoming, whatever the row says.
  const kickoff = r.kickoff ? Number(r.kickoff) : null;
  return {
    id: r.game_id,
    eventId: r.event_id || null,
    home: r.home,
    away: r.away,
    league: r.league || "",
    kickoff,
    status: r.status || "",
    upcoming: isUpcoming(r.status, kickoff),
    ft: { home: r.ft_home, draw: r.ft_draw, away: r.ft_away },
    dc: r.dc_1x == null ? null : { home_draw: r.dc_1x, home_away: r.dc_12, draw_away: r.dc_x2 },
    ht: r.ht_home == null ? null : { home: r.ht_home, draw: r.ht_draw, away: r.ht_away },
    cs: parseCs(r.cs_json),
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

/** Browsers on sportybet.com push here, so the route has to answer preflight. */
export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-push-token,x-fill-key,authorization");
  res.setHeader("Access-Control-Max-Age", "86400");
}
