// Tennis picks under the owner's rules: men's ATP / Challenger only (no SRL,
// UTR, ITF, women), no watch-list player, odds 1.20 or more, our % no more than
// 5 above SportyBet's, and no pick who has a poor record as OUR favourite
// (pre-match rating >= 60%, last 60 days, 4+ such matches, under 60% won).
const { fetchTennisCard } = await import(process.cwd() + "/api/_tennis.js");
const { forecastTennis } = await import(process.cwd() + "/api/_tn_model.js");
const { sql } = await import(process.cwd() + "/api/_db.js");
const TNW = (await import("node:fs")).readFileSync(new URL("./tn_watch.txt", import.meta.url), "utf8").split("\n").map((s) => s.trim()).filter(Boolean);
const games = await fetchTennisCard();
await forecastTennis(games);
const H = Number(process.argv[2] || 8);
const hist = await sql`SELECT home, away, r_home, r_away, pre_stats FROM tn_games WHERE pre_stats IS NOT NULL AND r_home IS NOT NULL AND r_home <> r_away AND start_at > ${Date.now() - 60 * 86400e3}`;
const fav = new Map();
for (const r of hist) {
  const p = Number(r.pre_stats);
  for (const [nm, pp, won] of [[r.home, p, r.r_home > r.r_away], [r.away, 1 - p, r.r_away > r.r_home]]) {
    if (pp < 0.6) continue;
    const x = fav.get(nm) || { n: 0, w: 0 }; x.n++; if (won) x.w++; fav.set(nm, x);
  }
}
// Owner's rule (27 Oct): never a pick whose players have never met (Sportradar versus).
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const gget = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
async function meetings(g) {
  const mi = await gget(`match_info/${String(g.eventId).replace("sr:match:", "")}`);
  const hu = mi?.match?.teams?.home?.uid, au = mi?.match?.teams?.away?.uid;
  if (!hu || !au) return null;
  const v = await gget(`stats_team_versus/${hu}/${au}`);
  return (v?.matches || []).filter((m) => m.result && m.result.winner && !m.walkover).length;
}
const rows = [];
for (const g of games) {
  if (!g.stats || !g.win || !(g.start < Date.now() + H * 3600e3) || g.start < Date.now() + 2 * 60e3) continue;
  const tourn = g.tourn || g.league || "";
  const home = g.stats.home >= g.stats.away, pct = home ? g.stats.home : g.stats.away;
  if (pct < 65) continue;
  const me = home ? g.home : g.away, opp = home ? g.away : g.home;
  const price = Number(home ? g.win.home : g.win.away), other = Number(home ? g.win.away : g.win.home);
  const sb = Math.round(100 * (1 / price) / (1 / price + 1 / other));
  const why = [];
  if (/SRL|UTR|ITF|women/i.test(tourn)) why.push("low-tier/women");
  if (TNW.includes(me) || TNW.includes(opp)) why.push("watch list");
  if (!(price >= 1.2)) why.push("odds " + price + " under 1.20");
  if (pct - sb > 5) why.push(`gap ${pct} vs SB ${sb}`);
  // Owner's rules (27 Oct): tennis only Good or Strong (Leans won 53%), and no leg at 1.40+.
  if (pct < 75) why.push("Lean, tennis needs Good+");
  if (price >= 1.4) why.push("odds 1.40+");
  if (!why.length) { const n = await meetings(g); if (!n) why.push("never met"); }
  const f = fav.get(me);
  if (f && f.n >= 4 && f.w / f.n < 0.6) why.push(`won only ${f.w}/${f.n} as our favourite`);
  const tag = pct >= 80 ? "STRONG" : pct >= 75 ? "good" : "lean";
  rows.push([why.length ? 0 : pct, `${why.length ? "OUT " : ""}${tag} ${pct}% SB ${sb}% @${price} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} Lagos | ${me} v ${opp} | ${tourn} | n ${g.nH}/${g.nA} | fav rec ${f ? f.w + "/" + f.n : "-"}${why.length ? " | " + why.join("; ") : ""}`]);
}
rows.sort((a, b) => b[0] - a[0]).forEach((r) => console.log(r[1]));
console.log("tennis games", games.length);
