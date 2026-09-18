// One place for the database handle and the row shape.
import { neon } from "@neondatabase/serverless";

export const sql = neon(process.env.DATABASE_URL);

export const COLUMNS = [
  "game_id", "event_id", "home", "away", "league", "kickoff", "status",
  "ft_home", "ft_draw", "ft_away", "dc_1x", "dc_12", "dc_x2",
  "ht_home", "ht_draw", "ht_away",
];

export function rowToGame(r) {
  return {
    id: r.game_id,
    home: r.home,
    away: r.away,
    league: r.league || "",
    kickoff: r.kickoff ? Number(r.kickoff) : null,
    status: r.status || "",
    upcoming: r.status === "Not start",
    ft: { home: r.ft_home, draw: r.ft_draw, away: r.ft_away },
    dc: r.dc_1x == null ? null : { home_draw: r.dc_1x, home_away: r.dc_12, draw_away: r.dc_x2 },
    ht: r.ht_home == null ? null : { home: r.ht_home, draw: r.ht_draw, away: r.ht_away },
    firstSeen: r.first_seen,
    lastSeen: r.last_seen,
  };
}

/** Browsers on sportybet.com push here, so the route has to answer preflight. */
export function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-push-token");
  res.setHeader("Access-Control-Max-Age", "86400");
}
