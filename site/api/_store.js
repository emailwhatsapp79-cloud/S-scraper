// Saving what a read saw. Keeps a running record with no collector anywhere:
// every visit to the site records the games the feeds were showing at the time.
import { sql, logErr } from "./_db.js";
import { leagueBucket } from "./_shape.js";

const FIELDS = 17;

let colsReady = false;
async function ensureCols() {
  if (colsReady) return;
  try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS cs_json TEXT`; } catch { /* already there */ }
  // Finished games whose SportyBet game id was handed to a new match (virtual
  // leagues reuse ids). Kept here so the history isn't overwritten.
  try {
    await sql`CREATE TABLE IF NOT EXISTS games_hist (LIKE games INCLUDING DEFAULTS)`;
    await sql`CREATE UNIQUE INDEX IF NOT EXISTS games_hist_event ON games_hist (event_id)`;
  } catch (e) { logErr("games_hist", e); }
  colsReady = true;
}

export async function store(games) {
  if (!Array.isArray(games) || !games.length) return 0;
  await ensureCols();

  const rows = games.map((g) => [
    g.id, g.eventId || null, g.home, g.away, g.league || "",
    g.kickoff || null, g.status || "",
    g.ft.home, g.ft.draw, g.ft.away,
    g.dc?.home_draw ?? null, g.dc?.home_away ?? null, g.dc?.draw_away ?? null,
    g.ht?.home ?? null, g.ht?.draw ?? null, g.ht?.away ?? null,
    g.cs ? JSON.stringify(g.cs) : null,
  ]);

  // A game id now pointing at a different match: archive the finished one
  // before the upsert below starts the row over for the new match.
  try {
    await sql`
      INSERT INTO games_hist
      SELECT g.* FROM games g
      JOIN unnest(${rows.map((r) => String(r[0]))}::text[], ${rows.map((r) => r[1])}::text[]) AS n(gid, ev)
        ON g.game_id = n.gid
      WHERE n.ev IS NOT NULL AND g.event_id IS DISTINCT FROM n.ev AND g.r_status IS NOT NULL
      ON CONFLICT DO NOTHING`;
  } catch (e) { logErr("archive reused ids", e); }

  // A new match on a reused id, or a result banked before this kickoff
  // (left over from an earlier match): drop the old result and odds.
  const NEW = `((EXCLUDED.event_id IS NOT NULL AND EXCLUDED.event_id IS DISTINCT FROM games.event_id)
    OR (games.r_status IS NOT NULL AND EXCLUDED.kickoff IS NOT NULL
        AND EXCLUDED.kickoff > EXTRACT(EPOCH FROM games.settled_at) * 1000))`;
  const keep = (col) => `CASE WHEN ${NEW} THEN EXCLUDED.${col} ELSE COALESCE(EXCLUDED.${col}, games.${col}) END`;
  const reset = (col) => `CASE WHEN ${NEW} THEN NULL ELSE games.${col} END`;

  const jobs = [];
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const values = chunk.map((_, j) => {
      const b = j * FIELDS;
      return "(" + Array.from({ length: FIELDS }, (_, k) => `$${b + k + 1}`).join(",") + ")";
    }).join(",");
    jobs.push(sql(
      `INSERT INTO games (game_id, event_id, home, away, league, kickoff, status,
         ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2, ht_home, ht_draw, ht_away, cs_json)
       VALUES ${values}
       ON CONFLICT (game_id) DO UPDATE SET
         event_id = COALESCE(EXCLUDED.event_id, games.event_id),
         home    = EXCLUDED.home,
         away    = EXCLUDED.away,
         status  = EXCLUDED.status,
         kickoff = COALESCE(EXCLUDED.kickoff, games.kickoff),
         league  = COALESCE(NULLIF(EXCLUDED.league,''), games.league),
         ft_home = EXCLUDED.ft_home, ft_draw = EXCLUDED.ft_draw, ft_away = EXCLUDED.ft_away,
         dc_1x   = ${keep("dc_1x")},
         dc_12   = ${keep("dc_12")},
         dc_x2   = ${keep("dc_x2")},
         ht_home = ${keep("ht_home")},
         ht_draw = ${keep("ht_draw")},
         ht_away = ${keep("ht_away")},
         cs_json = ${keep("cs_json")},
         r_hg = ${reset("r_hg")}, r_ag = ${reset("r_ag")},
         r_hthg = ${reset("r_hthg")}, r_htag = ${reset("r_htag")},
         r_status = ${reset("r_status")}, settled_at = ${reset("settled_at")},
         first_seen = CASE WHEN ${NEW} THEN now() ELSE games.first_seen END,
         last_seen = now()`,
      chunk.flat(),
    ));
  }
  await Promise.all(jobs);
  await pruneUnseen(games);
  return rows.length;
}

/** Drop leftover upcoming rows the live card no longer has, per league we just read. */
export async function pruneUnseen(fresh) {
  const eventIds = [...new Set((fresh || []).map((g) => g.eventId).filter(Boolean))];
  const buckets = [...new Set((fresh || []).map(leagueBucket))];
  if (!eventIds.length || !buckets.length) return 0;
  const now = Date.now();
  let n = 0;
  for (const b of buckets) {
    const like = "%" + b + "%";
    try {
      const r = await sql`
        DELETE FROM games
        WHERE kickoff > ${now}
          AND league ILIKE ${like}
          AND (event_id IS NULL OR NOT (event_id = ANY(${eventIds})))
        RETURNING game_id`;
      n += r.length;
    } catch (e) { logErr("prune " + b, e); }
  }
  return n;
}