const { sql } = await import(process.cwd() + "/api/_db.js");
const { listUpcomingTT, nameKey } = await import(process.cwd() + "/api/_tt.js");
const { annotateWatch } = await import(process.cwd() + "/api/_tt_watch.js");
const pairs = process.argv.slice(2).map((s) => s.split("|"));
const gs = (await listUpcomingTT(400)).filter((g) => pairs.some(([a, b]) => (g.home + g.away).includes(a) && (g.home + g.away).includes(b)));
await annotateWatch(gs);
const D = 86400e3, now = Date.now(), day0 = Math.floor((now + 3600e3) / D) * D - 3600e3;
for (const g of gs) {
  console.log(`\n${g.home} v ${g.away} | ${new Date(g.start + 3600e3).toISOString().slice(11, 16)} | @${g.win?.home}/${g.win?.away} | ours ${g.stats?.home}/${g.stats?.away} | n ${g.nH}/${g.nA} | h2h ${JSON.stringify(g.h2hRec)}`);
  for (const w of g.warn || []) console.log("  note:", w.name, "-", w.text);
  for (const nm of [g.home, g.away]) {
    const rows = await sql`SELECT home, away, r_home, r_away, win_home, win_away, start_at FROM tt_games WHERE (home=${nm} OR away=${nm}) AND win_home>1 AND r_home IS NOT NULL AND start_at > ${now - 45 * D}`;
    let fav = 0, favW = 0, dog = 0, dogW = 0; const today = [];
    for (const r of rows) {
      const me = r.home === nm, my = me ? +r.win_home : +r.win_away, ot = me ? +r.win_away : +r.win_home, won = me ? r.r_home > r.r_away : r.r_away > r.r_home;
      if (my < ot) { fav++; if (won) favW++; } else { dog++; if (won) dogW++; }
      if (+r.start_at >= day0) today.push(`${won ? "W" : "L"} ${me ? r.r_home + "-" + r.r_away : r.r_away + "-" + r.r_home} v ${(me ? r.away : r.home).split(",")[0]}`);
    }
    console.log(`  ${nm}: as fav ${favW}/${fav}, as dog ${dogW}/${dog} | today: ${today.join(", ") || "-"}`);
  }
}
