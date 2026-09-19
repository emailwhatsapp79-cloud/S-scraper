// Server-side screen — the six checks at their default thresholds, used to
// auto-record every game the screen matches (independent of the browser knobs).
import { fetchEvent, scoreOf } from "./_card.js";
import { sql, rowToGame } from "./_db.js";
import { loadPrefs } from "./_vault.js";

// Defaults match the browser DEFAULTS in core.js. The recorder reads the saved
// bands from the vault so History's auto-picks and the Matches screen never
// disagree; these are only the fallback when nothing has been saved yet.
export const CFG = {
  ft_fav_min: 1.50, ft_fav_max: 2.50, ft_dog_min: 3.70,
  ft_dc_fav_min: 1.17, ft_dc_fav_max: 1.30, ft_dc_dog_min: 1.89,
  ht_fav_min: 1.50, ht_fav_max: 3.50, ht_ratio_min: 1.70,
};

/** The saved bands merged over the defaults — the one screen everything uses. */
export async function loadCfg() {
  try {
    const { shape } = await loadPrefs();
    if (!shape) return { ...CFG };
    const out = { ...CFG };
    for (const k of Object.keys(CFG)) {
      if (typeof shape[k] === "number" && isFinite(shape[k])) out[k] = shape[k];
    }
    return out;
  } catch {
    return { ...CFG };
  }
}

const combine = (a, b) => Math.round(100 / (1 / a + 1 / b)) / 100;

/** Returns the pick when a game clears all six checks, else null. */
export function match(g, cfg = CFG) {
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
  if (!band(ft[fav], cfg.ft_fav_min, cfg.ft_fav_max)) return null;
  if (!(ft[dog] >= cfg.ft_dog_min)) return null;
  if (!band(favDC, cfg.ft_dc_fav_min, cfg.ft_dc_fav_max)) return null;
  if (!(dogDC >= cfg.ft_dc_dog_min)) return null;
  const hf = g.ht[fav], hd = g.ht[dog];
  if (!band(hf, cfg.ht_fav_min, cfg.ht_fav_max)) return null;
  if (!(hd / hf >= cfg.ht_ratio_min)) return null;

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
export async function recordPicks(games, opts = {}) {
  await ensure();
  const cfg = opts.cfg || await loadCfg();
  const rows = [];
  for (const g of games || []) {
    if (!opts.past && !g.upcoming) continue;
    const p = match(g, cfg);
    if (!p) continue;
    rows.push([g.id, g.eventId || null, g.home, g.away, g.league || "",
               g.kickoff || null, p.selection, p.label, p.price]);
  }
  if (!rows.length) return 0;

  // One bulk insert per 50 rows, not one round-trip per game — this was the poll's 504.
  const F = 9;
  let recorded = 0;
  for (let i = 0; i < rows.length; i += 50) {
    const chunk = rows.slice(i, i + 50);
    const values = chunk.map((_, j) => {
      const b = j * F;
      return "(" + Array.from({ length: F }, (_, k) => `$${b + k + 1}`).join(",") + ")";
    }).join(",");
    const r = await sql(
      `INSERT INTO picks (game_id, event_id, home, away, league, kickoff, selection, selection_label, price)
       VALUES ${values} ON CONFLICT (game_id) DO NOTHING RETURNING game_id`,
      chunk.flat());
    recorded += r.length;
  }
  return recorded;
}

/** Catch games the screen matched that were already off the upcoming card. */
export async function recordStoredPicks() {
  const rows = await sql`SELECT * FROM games ORDER BY kickoff DESC NULLS LAST LIMIT 800`;
  return recordPicks(rows.map(rowToGame), { past: true });
}

const dcHit = (sel, h, a) =>
  sel === "1X" ? h >= a : sel === "X2" ? a >= h : sel === "12" ? h !== a : null;

/** Settle picks whose games have ended. vFootball runs ~30 real minutes. */
export async function settlePicks(limit = 60) {
  await ensure();
  const cutoff = Date.now() - 28 * 60 * 1000;
  const open = await sql`
    SELECT * FROM picks
    WHERE won IS NULL AND kickoff IS NOT NULL AND kickoff < ${cutoff}
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
  let booked = new Set();
  try {
    const legs = await sql`SELECT DISTINCT game_id FROM slip_legs`;
    booked = new Set(legs.map((r) => r.game_id));
  } catch { /* slips table may not exist yet */ }
  return rows.filter((p) => !booked.has(p.game_id)).map(shapePick);
}
