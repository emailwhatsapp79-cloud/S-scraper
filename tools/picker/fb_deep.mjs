const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
for (const id of process.argv.slice(2)) {
  const T = (await get(`match_info/${id}`))?.match?.teams; if (!T) { console.log(id, "no info"); continue; }
  console.log(`\n== ${T.home.name} v ${T.away.name}`);
  for (const s of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[s].uid}/20`);
    const ms = (d?.matches || []).filter((m) => m.result?.home != null).slice(0, 20);
    console.log(`  ${T[s].name} last 20 (own-opp, HT):`, ms.map((m) => { const me = m.teams.home.uid === T[s].uid; const p1 = m.periods?.p1; return `${me ? m.result.home : m.result.away}-${me ? m.result.away : m.result.home}${p1 ? `(${me ? p1.home : p1.away}-${me ? p1.away : p1.home})` : ""}${me ? "H" : "A"}`; }).join(" "));
  }
  const vs = await get(`stats_team_versus/${T.home.uid}/${T.away.uid}`);
  console.log("  h2h:", (vs?.matches || []).filter((m) => m.result?.home != null).slice(0, 8).map((m) => `${m.time.date} ${m.teams.home.name.split(" ").slice(-1)} ${m.result.home}-${m.result.away}${m.periods?.p1 ? `(${m.periods.p1.home}-${m.periods.p1.away})` : ""}`).join(" | "));
}
