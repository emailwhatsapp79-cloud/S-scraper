const { listUpcomingTT, fetchTTCard, normalise } = await import(process.cwd() + "/api/_tt.js");
const { annotateWatch } = await import(process.cwd() + "/api/_tt_watch.js");
const H = Number(process.argv[2] || 3);
let live = null;
try { const { events } = await fetchTTCard(); live = new Map(events.map(normalise).map((g) => [g.id, g.open])); } catch {}
const games = (await listUpcomingTT(400)).filter((g) => g.start > Date.now() + 3 * 60e3 && g.start < Date.now() + H * 3600e3);
await annotateWatch(games);
// Owner's rule: no game where either player has beaten the price as underdog even once today.
const { sql } = await import(process.cwd() + "/api/_db.js");
const { upsetsToday } = await import(process.cwd() + "/api/_tt_watch.js");
const { nameKey } = await import(process.cwd() + "/api/_tt.js");
const nm = [...new Set(games.flatMap((g) => [g.home, g.away]))];
const dogToday = upsetsToday(await sql`SELECT home, away, r_home, r_away, win_home, win_away, start_at FROM tt_games WHERE (home = ANY(${nm}) OR away = ANY(${nm})) AND r_home IS NOT NULL AND start_at > ${Date.now() - 86400e3}`);
// Owner's rule (24 Oct): leave out a Setka pick whose last match was a SWING
// (every set won/lost easily, back and forth). Replaces the 5-set rule.
const { lastSetkaMatch, isSwing, recentChoke } = await import(new URL("./setka_last.mjs", import.meta.url));
const rows = [];
for (const g of games) {
  if (!g.stats || !g.win) continue;
  const home = g.stats.home >= g.stats.away, pct = home ? g.stats.home : g.stats.away;
  const price = Number(home ? g.win.home : g.win.away), other = Number(home ? g.win.away : g.win.home);
  if (!(price > 1)) continue;
  // Owner's rule (26 Oct): no leg under 1.20.
  if (price < 1.2) continue;
  // Owner's rules (27 Oct, from our own 427 graded legs): no leg at 1.40+ (won 50-56%),
  // and no Czech Liga Pro / TT Cup (58% v 72%).
  if (price >= 1.4) continue;
  if (/czech liga pro|tt cup/i.test(g.tourn || "")) continue;
  const minN = Math.min(g.nH || 0, g.nA || 0);
  if (g.women) continue;
  // Owner's rule: never a game with a watch-list / blacklist player or any warning.
  { const ps = g.stats.home >= g.stats.away ? "home" : "away"; if ((g.warn || []).some((w) => !w.pick && !(w.hot && pct >= 75))) continue; }
  const oppSide = home ? "away" : "home";
  const hotOpp = g.hot && g.hot[oppSide];
  const tag = pct >= 75 ? (minN >= 30 && !hotOpp ? "STRONG" : "good") : pct >= 70 ? "good" : pct >= 65 ? "lean" : null;
  if (!tag) continue;
  // Owner's rule (model-vs-SB gap): skip when our % is more than 5 above SportyBet's.
  { const pr = Number(home ? g.win.home : g.win.away), ot = Number(home ? g.win.away : g.win.home); if (pct - Math.round(100 * (1 / pr) / (1 / pr + 1 / ot)) > 5) continue; }
  // Underdog win today by either player: backtest says it helps Good/Lean a little (68% vs 72%), not Strong (80% vs 78%).
  // Owner's rule (option 2): no Good/Lean game where either player won as the underdog today; Strong passes.
  if (tag !== "STRONG" && (dogToday.get(nameKey(g.home)) || dogToday.get(nameKey(g.away)))) continue;
  if (tag === "STRONG" && /setka/i.test(g.tourn || "")) { const P = home ? g.home : g.away; const C = await recentChoke(P, nameKey, g.start); if (C) { console.log(`OUT STRONG ${pct}% | ${P} v ${home ? g.away : g.home} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} Lagos | 2-1 collapse rule: lost from 2-1 up v ${C.opp} ${C.s.map((x) => x.join("-")).join(", ")}`); continue; } }
  if (/setka/i.test(g.tourn || "")) { const P = home ? g.home : g.away; const L = await lastSetkaMatch(P, nameKey, g.start); if (L && isSwing(L.s)) { console.log(`OUT ${tag} ${pct}% | ${P} v ${home ? g.away : g.home} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} Lagos | swing rule: last match v ${L.opp} ${L.s.map((x) => x.join("-")).join(", ")}`); continue; } }
  // Owner's rules (27 Oct): never a game whose players have never met; no Lean
  // whose picked player carries a pick-side note (lost today as favourite / 0-3,
  // or under 10 SportyBet-priced games).
  { const P = home ? g.home : g.away, line = `${home ? g.home : g.away} v ${home ? g.away : g.home} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} Lagos`;
    if (!(g.h2hRec && g.h2hRec.n > 0)) { console.log(`OUT ${tag} ${pct}% | ${line} | never met`); continue; }
    const notes = (g.warn || []).filter((w) => w.pick && w.name === P);
    if (tag === "lean" && notes.length) { console.log(`OUT lean ${pct}% | ${line} | pick note: ${notes.map((w) => w.text).join("; ")}`); continue; } }
  const sb = Math.round(100 * (1 / price) / (1 / price + 1 / other));
  const open = live ? (live.get(g.id) === true ? "" : live.has(g.id) ? " SUSPENDED" : " NOT-LISTED") : "";
  rows.push([pct, `${tag.padEnd(6)} ${pct}% | SB ${sb}% @${price} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} Lagos | ${home ? g.home : g.away} v ${home ? g.away : g.home} | ${g.tourn} | n ${g.nH}/${g.nA}${g.warn ? " | WARN " + g.warn.map((w) => w.name + ": " + w.text).join("; ") : ""}${open}`]);
}
rows.sort((a, b) => b[0] - a[0]).forEach((r) => console.log(r[1]));
console.log("games in window", games.length);
