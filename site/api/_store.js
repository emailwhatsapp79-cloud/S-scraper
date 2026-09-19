// Saving what a read saw. Keeps a running record with no collector anywhere:
// every visit to the site records the games the feeds were showing at the time.
import { sql } from "./_db.js";

const FIELDS = 16;

export async function store(games) {
  if (!Array.isArray(games) || !games.length) return 0;

  const rows = games.map((g) => [
    g.id, g.eventId || null, g.home, g.away, g.league || "",
    g.kickoff || null, g.status || "",
    g.ft.home, g.ft.draw, g.ft.away,
    g.dc?.home_draw ?? null, g.dc?.home_away ?? null, g.dc?.draw_away ?? null,
    g.ht?.home ?? null, g.ht?.draw ?? null, g.ht?.away ?? null,
  ]);

  const jobs = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const values = chunk.map((_, j) => {
      const b = j * FIELDS;
      return "(" + Array.from({ length: FIELDS }, (_, k) => `$${b + k + 1}`).join(",") + ")";
    }).join(",");
    jobs.push(sql(
      `INSERT INTO games (game_id, event_id, home, away, league, kickoff, status,
         ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2, ht_home, ht_draw, ht_away)
       VALUES ${values}
       ON CONFLICT (game_id) DO UPDATE SET
         event_id = COALESCE(EXCLUDED.event_id, games.event_id),
         status  = EXCLUDED.status,
         kickoff = COALESCE(EXCLUDED.kickoff, games.kickoff),
         league  = COALESCE(NULLIF(EXCLUDED.league,''), games.league),
         ft_home = EXCLUDED.ft_home, ft_draw = EXCLUDED.ft_draw, ft_away = EXCLUDED.ft_away,
         dc_1x   = COALESCE(EXCLUDED.dc_1x, games.dc_1x),
         dc_12   = COALESCE(EXCLUDED.dc_12, games.dc_12),
         dc_x2   = COALESCE(EXCLUDED.dc_x2, games.dc_x2),
         ht_home = COALESCE(EXCLUDED.ht_home, games.ht_home),
         ht_draw = COALESCE(EXCLUDED.ht_draw, games.ht_draw),
         ht_away = COALESCE(EXCLUDED.ht_away, games.ht_away),
         last_seen = now()`,
      chunk.flat(),
    ));
  }
  await Promise.all(jobs);
  return rows.length;
}
