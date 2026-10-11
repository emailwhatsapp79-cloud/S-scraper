// Players to be careful with on the table-tennis card, shown as a warning on
// any game they play. Two kinds:
//   - the owner's watch list (players who have cost slips, or that he wants to
//     keep an eye on), matched on the name key so "Michal Oracz" and
//     "Oracz, Michal" are the same;
//   - anyone whose record as SportyBet's big favourite (1.40 or shorter, last
//     90 days) has more losses than the prices said, by 1.5 or more.
// Warnings only: the tags still come from the stats.
import { sql } from "./_db.js";
import { nameKey } from "./_tt.js";

const WATCH = [
  "Oracz, Jacek", "Oracz, Michal", "Oracz, Lukasz",
  "Ostrovskyi, Pavlo", "Osadchyi, Oleksandr", "Osipov, Sergey",
  "Tuzhylin, Oleksandr", "Fomin, Andriej", "Guzik, Michal", "Jadach, Oskar",
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

/** Sets g.warn = [{ side, name, watch, text }] on games with a flagged player. */
export async function annotateWatch(games) {
  if (!games || !games.length) return games;
  const names = [...new Set(games.flatMap((g) => [g.home, g.away]).filter(Boolean))];
  const since = Date.now() - 90 * 86400000;
  const rows = await sql`
    SELECT home, away, r_home, r_away, win_home, win_away FROM tt_games
    WHERE (home = ANY(${names}) OR away = ANY(${names}))
      AND win_home > 1 AND win_away > 1 AND r_home IS NOT NULL AND start_at > ${since}`;
  const recs = favRecords(rows);
  for (const g of games) {
    const warn = [];
    for (const side of ["home", "away"]) {
      const w = warnFor(g[side], recs.get(nameKey(g[side])));
      if (w) warn.push({ side, ...w });
    }
    if (warn.length) g.warn = warn;
  }
  return games;
}
