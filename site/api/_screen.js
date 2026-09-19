// Server-side screen — the six checks at their default thresholds, used to
// auto-record every game the screen matches (independent of the browser knobs).
import { fetchEvent, scoreOf } from "./_card.js";
import { sql } from "./_db.js";

export const CFG = {
  ft_fav_min: 1.50, ft_fav_max: 2.50, ft_dog_min: 3.70,
  ft_dc_fav_min: 1.17, ft_dc_fav_max: 1.30, ft_dc_dog_min: 1.89,
  ht_fav_min: 1.10, ht_fav_max: 3.00, ht_ratio_min: 1.70,
};

const combine = (a, b) => Math.round(100 / (1 / a + 1 / b)) / 100;

/** Returns the pick when a game clears all six checks, else null. */
export function match(g) {
  if (!g || !g.ft || !g.ht) return null;                 // ht is required for a SHOW
  const ft = g.ft;
  const dc = g.dc || {
    home_draw: combine(ft.home, ft.draw),
    home_away: combine(ft.home, ft.away),
    draw_away: combine(ft.draw, ft.away),
  };
  const fav = ft.home <= ft.away ? "home" : "away";
  const dog = fav === "home" ? "away" : "home";
  const favDC = fav === "home" ? dc.home_draw : dc.draw_away;
  const dogDC = dog === "home" ? dc.home_draw : dc.draw_away;

  const band = (v, lo, hi) => v >= lo && v <= hi;
  if (!band(ft[fav], CFG.ft_fav_min, CFG.ft_fav_max)) return null;
  if (!(ft[dog] >= CFG.ft_dog_min)) return null;
  if (!band(favDC, CFG.ft_dc_fav_min, CFG.ft_dc_fav_max)) return null;
  if (!(dogDC >= CFG.ft_dc_dog_min)) return null;
  const hf = g.ht[fav], hd = g.ht[dog];
  if (!band(hf, CFG.ht_fav_min, CFG.ht_fav_max)) return null;
  if (!(hd / hf >= CFG.ht_ratio_min)) return null;

  return {
    selection: fav === "home" ? "1X" : "X2",
    label: fav === "home" ? "Home or Draw" : "Draw or Away",
    price: favDC,
  };
}

async function ensure() {
  await sql`CREATE TABLE IF NOT EXISTS picks (
    game_id TEXT PRIMARY KEY,
    event_id TEXT,
    home TEXT, away TEXT, league TEXT,
    kickoff BIGINT,
    selection TEXT NOT NULL,
    selection_label TEXT,
    price DOUBLE PRECISION NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    match_status TEXT,
    set_score TEXT,
    ft_home INT, ft_away INT,
    won TEXT,
    settled_at TIMESTAMPTZ
  )`;
}

/** Record every matching game as an auto-pick. First sighting wins (odds kept). */
export async function recordPicks(games) {
  await ensure();
  let recorded = 0;
  for (const g of games || []) {
    if (!g.upcoming) continue;                     // only pick before kick-off
    const p = match(g);
    if (!p) continue;
    await sql`
      INSERT INTO picks (game_id, event_id, home, away, league, kickoff, selection, selection_label, price)
      VALUES (${g.id}, ${g.eventId || null}, ${g.home}, ${g.away}, ${g.league || ""},
              ${g.kickoff || null}, ${p.selection}, ${p.label}, ${p.price})
      ON CONFLICT (game_id) DO NOTHING`;
    recorded += 1;                                 // count of matched games this pass
  }
  return recorded;
}

const dcHit = (sel, h, a) =>
  sel === "1X" ? h >= a : sel === "X2" ? a >= h : sel === "12" ? h !== a : null;

/** Settle picks whose games have ended. Batched so the request never hangs. */
export async function settlePicks(limit = 60) {
  await ensure();
  const now = Date.now();
  const open = await sql`
    SELECT * FROM picks
    WHERE won IS NULL AND kickoff IS NOT NULL AND kickoff < ${now - 60000}
      AND event_id IS NOT NULL
    ORDER BY kickoff ASC LIMIT ${limit}`;
  if (!open.length) return 0;

  // Fetch every event in parallel, then write results.
  const snaps = await Promise.all(open.map((p) => fetchEvent(p.event_id).then(scoreOf).catch(() => null)));
  let settled = 0;
  for (let i = 0; i < open.length; i++) {
    const p = open[i], snap = snaps[i];
    if (!snap || !snap.ended) continue;
    const won = dcHit(p.selection, snap.ftHome, snap.ftAway);
    await sql`
      UPDATE picks SET
        match_status = ${snap.status}, set_score = ${snap.setScore},
        ft_home = ${snap.ftHome}, ft_away = ${snap.ftAway},
        won = ${won == null ? null : won ? "yes" : "no"},
        settled_at = now()
      WHERE game_id = ${p.game_id}`;
    settled += 1;
  }
  return settled;
}

export function shapePick(p) {
  return {
    gameId: p.game_id, home: p.home, away: p.away, league: p.league || "",
    kickoff: p.kickoff ? Number(p.kickoff) : null,
    selection: p.selection, label: p.selection_label, price: Number(p.price),
    status: p.match_status || "", setScore: p.set_score || "",
    ft: p.ft_home == null ? null : { home: p.ft_home, away: p.ft_away },
    won: p.won == null ? null : p.won === "yes",
    settledAt: p.settled_at,
  };
}

export async function listPicks(scope = "settled", limit = 300) {
  await ensure();
  const rows = scope === "settled"
    ? await sql`SELECT * FROM picks WHERE won IS NOT NULL ORDER BY settled_at DESC LIMIT ${limit}`
    : await sql`SELECT * FROM picks ORDER BY kickoff DESC LIMIT ${limit}`;
  return rows.map(shapePick);
}
