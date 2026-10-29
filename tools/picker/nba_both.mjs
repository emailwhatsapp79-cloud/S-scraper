// Every total line on one NBA game, both sides, with this season's games and head-to-head.
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const SINCE = Date.UTC(2026, 8, 25) / 1000;
const up = await fetch("https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:2&marketId=1&pageSize=100&pageNum=1&option=1", { headers: H }).then((r) => r.json());
const evs = up.data.tournaments.filter((t) => /NBA$/i.test(t.name)).flatMap((t) => t.events);
for (const e of evs) {
  const id = e.eventId.replace("sr:match:", "");
  const T = (await get(`match_info/${id}`))?.match?.teams; if (!T) continue;
  const g = {};
  for (const s of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[s].uid}/20`);
    g[s] = (d?.matches || []).filter((m) => m.result?.home != null && (m.time?.uts || 0) > SINCE).map((m) => {
      const me = m.teams.home.uid === T[s].uid; return { tot: m.result.home + m.result.away, mine: me ? m.result.home : m.result.away, conc: me ? m.result.away : m.result.home, opp: (me ? m.teams.away : m.teams.home).name, date: m.time.date, pre: m.tournament?.name || "" };
    });
  }
  const vs = await get(`stats_team_versus/${T.home.uid}/${T.away.uid}`);
  const h2h = (vs?.matches || []).filter((m) => m.result?.home != null).slice(0, 8).map((m) => ({ d: m.time.date, s: `${m.teams.home.name.split(" ").pop()} ${m.result.home}-${m.result.away} ${m.teams.away.name.split(" ").pop()}`, tot: m.result.home + m.result.away }));
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${e.eventId}&productId=3`, { headers: H }).then((r) => r.json())).data;
  console.log(`\n== ${new Date(e.estimateStartTime + 3600e3).toISOString().slice(11, 16)} ${e.homeTeamName} v ${e.awayTeamName}`);
  for (const s of ["home", "away"]) console.log(`  ${T[s].name}:`, g[s].map((x) => `${x.mine}-${x.conc} v ${x.opp.split(" ").pop()}${/pre/i.test(x.pre) ? "(pre)" : ""} [${x.tot}]`).join(", "));
  console.log("  h2h last 8:", h2h.map((x) => `${x.d} ${x.s} [${x.tot}]`).join(" | "));
  const all = [...g.home, ...g.away].map((x) => x.tot), h2t = h2h.map((x) => x.tot);
  for (const m of ev.markets || []) {
    const mt = m.desc.match(/^Over\/Under \(incl\. overtime\) ([\d.]+)$/); if (!mt) continue;
    const L = +mt[1]; const o = m.outcomes.find((x) => /^Over/.test(x.desc)), u = m.outcomes.find((x) => /^Under/.test(x.desc));
    const oh = all.filter((v) => v > L).length, hh = h2t.filter((v) => v > L).length;
    console.log(`  ${L}: Over @${o?.odds} ${oh}/${all.length} (h2h ${hh}/${h2t.length}) | Under @${u?.odds} ${all.length - oh}/${all.length} (h2h ${h2t.length - hh}/${h2t.length})`);
  }
}
