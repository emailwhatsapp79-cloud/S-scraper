// Players to be careful with on the table-tennis card, shown as a warning on
// any game they play. Two kinds:
//   - the owner's watch list (players who have cost slips, or that he wants to
//     keep an eye on), matched on the name key so "Michal Oracz" and
//     "Oracz, Michal" are the same;
//   - anyone whose record as SportyBet's big favourite (1.40 or shorter, last
//     45 days) has more losses than the prices said, by 1.5 or more.
// Plus two things that cap the tag on the page (tt.html levelOf):
//   - a women's game (either player has a Setka Cup Women record): Strong
//     there won 4 of 7 on SportyBet's games against 82% in men's, so the owner
//     wants them hardly ever on a slip — capped at Lean;
//   - a hot underdog: the pick's opponent has already beaten the price as the
//     underdog 2+ times today (Lagos day), like Tymchenko on 11 Oct — capped at
//     Good, never Strong.
// And two pick-side notes (formFlags), shown on the card but not stopping the
// tag: the picked player has fewer than 10 SportyBet-priced games in 45 days,
// or already lost today as the favourite or by 0-3. Backtested on 14 days of
// graded picks, the games they flag won as often as the rest.
import { sql } from "./_db.js";
import { nameKey } from "./_tt.js";

const WATCH = [
  "Oracz, Jacek", "Oracz, Michal", "Oracz, Lukasz",
  "Ostrovskyi, Pavlo", "Osadchyi, Oleksandr", "Osipov, Sergey",
  "Tuzhylin, Oleksandr", "Fomin, Andriej", "Guzik, Michal", "Jadach, Oskar",
  // 17 Oct, slip MUC6FM: Oanta lost from 2-0 up (Good), Berezynskyi 0-3 (Strong).
  "Oanta, Mihail", "Berezynskyi, Serhii",
  // 17 Oct, slip PHVZHG: Seeman (Lean) 0-2 down to Cmil.
  "Seeman, Jan",
  // 19 Oct, slip WEVZ3H: Fastov lost 0-3 to Aldayev as favourite (5 of 11 as favourite).
  "Fastov, Andrii",
  // 20 Oct, slip RB3GJ0: Kovshun lost 0-2, won 2-2, then trailed the decider v Kolesnykov.
  "Kovshun, Yaroslav",
  // 24 Oct, slip WTCVHB: Rak (Lean) led sets early then lost them 8-11, 7-11 v Haiseniuk.
  "Rak, Serhii",
  // 24 Oct, slip MPJMW4: Boltenkov led 2-1 in sets, then lost 9-11, 5-11 to Sydorenko V.
  "Boltenkov, Denys",
];
const WATCH_KEYS = new Set(WATCH.map(nameKey));

export const BIG_FAV = 1.40;

/** Per name key: { n, lost, exp } as big favourite, from finished priced rows. */
export function favRecords(rows) {
  const out = new Map();
  for (const r of rows) {
    const wh = Number(r.win_home), wa = Number(r.win_away);
    const rh = Number(r.r_home), ra = Number(r.r_away);
    if (!(wh > 1 && wa > 1) || rh === ra) continue;
    const ph = (1 / wh) / (1 / wh + 1 / wa);
    for (const [nm, price, p, won] of [[r.home, wh, ph, rh > ra], [r.away, wa, 1 - ph, ra > rh]]) {
      if (price > BIG_FAV) continue;
      const k = nameKey(nm);
      const x = out.get(k) || { n: 0, lost: 0, exp: 0 };
      x.n++; x.exp += 1 - p; if (!won) x.lost++;
      out.set(k, x);
    }
  }
  return out;
}

/** The warning for one player, or null. */
export function warnFor(name, rec) {
  const k = nameKey(name);
  const parts = [];
  if (WATCH_KEYS.has(k)) parts.push("on your watch list");
  if (rec && rec.n >= 5 && rec.lost - rec.exp >= 1.5) {
    parts.push(`lost ${rec.lost} of ${rec.n} as big favourite (prices said ~${Math.round(rec.exp)})`);
  }
  return parts.length ? { name, watch: WATCH_KEYS.has(k), text: parts.join("; ") } : null;
}

export const MIN_PRICED = 10;

/** Per name key: { priced, slump } from deduped priced rows. `priced` counts
 *  SportyBet-priced finished games (Seeman's 68% on 17 Oct rested on 359 games
 *  from other feeds and 1 priced one); `slump` describes a loss earlier today
 *  (Lagos day) as the favourite or by 0-3, like his 0-3 to Sabuka before
 *  losing our pick. */
export function formFlags(rows, now = Date.now()) {
  const lag = 3600e3;
  const dayStart = Math.floor((now + lag) / 86400e3) * 86400e3 - lag;
  const out = new Map();
  const get = (k) => out.get(k) || (out.set(k, { priced: 0, slump: null }), out.get(k));
  for (const r of rows) {
    const wh = Number(r.win_home), wa = Number(r.win_away), rh = Number(r.r_home), ra = Number(r.r_away);
    if (!(wh > 1 && wa > 1) || rh === ra) continue;
    for (const [nm, my, ot, won, sw, sl] of [[r.home, wh, wa, rh > ra, rh, ra], [r.away, wa, wh, ra > rh, ra, rh]]) {
      const x = get(nameKey(nm));
      x.priced++;
      if (Number(r.start_at) < dayStart || won) continue;
      const opp = (nm === r.home ? r.away : r.home).split(",")[0];
      if (my < ot) x.slump = `lost ${sw}-${sl} to ${opp} today as the favourite (@${my})`;
      else if (sw === 0 && sl === 3 && !x.slump) x.slump = `lost 0-3 to ${opp} today`;
    }
  }
  return out;
}

/** Per name key: wins as the price underdog since the start of the Lagos day. */
export function upsetsToday(rows, now = Date.now()) {
  const lag = 3600e3;
  const dayStart = Math.floor((now + lag) / 86400e3) * 86400e3 - lag;
  const out = new Map();
  for (const r of rows) {
    if (Number(r.start_at) < dayStart) continue;
    const wh = Number(r.win_home), wa = Number(r.win_away), rh = Number(r.r_home), ra = Number(r.r_away);
    if (!(wh > 1 && wa > 1) || rh === ra || wh === wa) continue;
    const dog = wh > wa ? r.home : r.away, dogWon = wh > wa ? rh > ra : ra > rh;
    if (dogWon) { const k = nameKey(dog); out.set(k, (out.get(k) || 0) + 1); }
  }
  return out;
}

/** Sets g.warn = [{ side, name, watch, text }] on games with a flagged player. */
export async function annotateWatch(games) {
  if (!games || !games.length) return games;
  const names = [...new Set(games.flatMap((g) => [g.home, g.away]).filter(Boolean))];
  const since = Date.now() - 45 * 86400000;
  const rows = await sql`
    SELECT home, away, r_home, r_away, win_home, win_away, start_at FROM tt_games
    WHERE (home = ANY(${names}) OR away = ANY(${names}))
      AND win_home > 1 AND win_away > 1 AND r_home IS NOT NULL AND start_at > ${since}`;
  const recs = favRecords(rows);
  // Same-day results come in through several feeds; count each meeting once.
  const seen = new Set();
  const once = rows.filter((r) => {
    const k = [nameKey(r.home), nameKey(r.away)].sort().join(">") + "@" + Math.floor(Number(r.start_at) / 900000);
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const today = upsetsToday(once);
  const flags = formFlags(once);
  let women = new Set();
  try {
    const keys = [...new Set(names.map(nameKey))];
    // A Setka Cup Women record, or a meeting with someone who has one: men and
    // women never meet, so one known woman marks everyone she has played.
    const wr = await sql`
      WITH w AS (SELECT name_key FROM tt_ratings WHERE tourn ILIKE ${"%women%"})
      SELECT name_key AS k FROM w WHERE name_key = ANY(${keys})
      UNION
      SELECT x.k FROM (SELECT a AS k, b AS o FROM tt_h2h UNION ALL SELECT b, a FROM tt_h2h) x
      WHERE x.k = ANY(${keys}) AND x.o IN (SELECT name_key FROM w)`;
    women = new Set(wr.map((r) => r.k));
  } catch { /* no women flag */ }
  for (const g of games) {
    const warn = [];
    for (const side of ["home", "away"]) {
      const w = warnFor(g[side], recs.get(nameKey(g[side])));
      if (w) warn.push({ side, ...w });
      const hot = today.get(nameKey(g[side])) || 0;
      if (hot >= 2) {
        warn.push({ side, name: g[side], hot: true, text: `\ud83d\udd25 beat the price ${hot} times today as the underdog` });
        (g.hot || (g.hot = {}))[side] = hot;
      }
      // Pick-side checks: they stop a tag only when this side is the pick.
      const f = flags.get(nameKey(g[side])) || { priced: 0, slump: null };
      if (f.priced < MIN_PRICED) {
        warn.push({ side, name: g[side], pick: true, text: `only ${f.priced} SportyBet-priced game${f.priced === 1 ? "" : "s"} in 45 days` });
      }
      if (f.slump) warn.push({ side, name: g[side], pick: true, text: f.slump });
    }
    if (warn.length) g.warn = warn;
    if (women.has(nameKey(g.home)) || women.has(nameKey(g.away))) g.women = true;
  }
  return games;
}
