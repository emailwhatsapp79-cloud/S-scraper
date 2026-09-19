// Whole-card results. Settles finished games in the games table (not just
// picks), so any band set can be backtested over real outcomes.
import { sql } from "./_db.js";
import { fetchEvent, scoreOf } from "./_card.js";

/** Fetch and store results for finished games that don't have one yet. */
export async function settleGames(limit = 45) {
  const now = Date.now();
  const due = await sql`
    SELECT game_id, event_id FROM games
    WHERE r_status IS NULL AND event_id IS NOT NULL
      AND kickoff IS NOT NULL AND kickoff < ${now - 90000}
    ORDER BY kickoff ASC LIMIT ${limit}`;
  if (!due.length) return { checked: 0, settled: 0 };

  const snaps = await Promise.all(
    due.map((g) => fetchEvent(g.event_id).then(scoreOf).catch(() => null))
  );

  let settled = 0;
  for (let i = 0; i < due.length; i++) {
    const snap = snaps[i];
    if (!snap || !snap.ended || snap.ftHome == null) continue;
    await sql`
      UPDATE games SET
        r_hg = ${snap.ftHome}, r_ag = ${snap.ftAway},
        r_hthg = ${snap.htHome}, r_htag = ${snap.htAway},
        r_status = ${snap.status}, settled_at = now()
      WHERE game_id = ${due[i].game_id}`;
    settled += 1;
  }
  return { checked: due.length, settled };
}

/** Settled games with odds + result, compact, for the Lab to analyse. */
export async function settledGames(limit = 4000) {
  const rows = await sql`
    SELECT game_id, league, kickoff,
           ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2,
           ht_home, ht_draw, ht_away, r_hg, r_ag, r_hthg, r_htag
    FROM games WHERE r_status IS NOT NULL
    ORDER BY kickoff DESC LIMIT ${limit}`;
  return rows.map((r) => ({
    id: r.game_id, league: r.league || "", kickoff: r.kickoff ? Number(r.kickoff) : null,
    ft: { home: r.ft_home, draw: r.ft_draw, away: r.ft_away },
    dc: r.dc_1x == null ? null : { home_draw: r.dc_1x, home_away: r.dc_12, draw_away: r.dc_x2 },
    ht: r.ht_home == null ? null : { home: r.ht_home, draw: r.ht_draw, away: r.ht_away },
    res: { hg: r.r_hg, ag: r.r_ag, hthg: r.r_hthg, htag: r.r_htag },
  }));
}
