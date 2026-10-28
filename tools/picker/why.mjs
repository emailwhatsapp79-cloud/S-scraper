const { sql } = await import(process.cwd() + "/api/_db.js");
const { listUpcomingTT, nameKey } = await import(process.cwd() + "/api/_tt.js");
const { annotateWatch, upsetsToday } = await import(process.cwd() + "/api/_tt_watch.js");
const H = Number(process.argv[2] || 7);
const games = (await listUpcomingTT(400)).filter((g) => g.start > Date.now() + 3 * 60e3 && g.start < Date.now() + H * 3600e3);
await annotateWatch(games);
const nm = [...new Set(games.flatMap((g) => [g.home, g.away]))];
const dog = upsetsToday(await sql`SELECT home, away, r_home, r_away, win_home, win_away, start_at FROM tt_games WHERE (home = ANY(${nm}) OR away = ANY(${nm})) AND r_home IS NOT NULL AND start_at > ${Date.now() - 86400e3}`);
let noStats = 0;
for (const g of games.sort((a, b) => a.start - b.start)) {
  if (!g.stats || !g.win) { noStats++; continue; }
  const home = g.stats.home >= g.stats.away, pct = home ? g.stats.home : g.stats.away;
  if (pct < 70) continue;
  const price = Number(home ? g.win.home : g.win.away), other = Number(home ? g.win.away : g.win.home);
  const sb = Math.round(100 * (1 / price) / (1 / price + 1 / other));
  const why = [];
  if (g.women) why.push("women");
  if (!(price > 1.09)) why.push("odds " + price);
  if (pct - sb > 5) why.push(`model ${pct} vs SB ${sb}`);
  for (const w of g.warn || []) if (!w.pick) why.push(w.name.split(",")[0] + ": " + w.text);
  for (const p of [g.home, g.away]) if (dog.get(nameKey(p))) why.push(p.split(",")[0] + " won as underdog today x" + dog.get(nameKey(p)));
  console.log(`${why.length ? "OUT" : "OK "} ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} ${pct}%/SB${sb} @${price} ${home ? g.home : g.away} v ${home ? g.away : g.home} | ${g.tourn}${why.length ? " | " + why.join("; ") : ""}`);
}
console.log("games", games.length, "no stats", noStats);
