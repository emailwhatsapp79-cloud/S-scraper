// Tonight's NBA: which alternative total lines each team's recent games cleared.
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const SINCE = Date.UTC(2026, 8, 25) / 1000; // this season incl. preseason, not summer league
const FROM = Number(process.argv[2]), TO = Number(process.argv[3]);
const up = await fetch("https://www.sportybet.com/api/ng/factsCenter/pcUpcomingEvents?sportId=sr:sport:2&marketId=1&pageSize=100&pageNum=1&option=1", { headers: H }).then((r) => r.json());
const evs = up.data.tournaments.filter((t) => /^NBA$|NBA$/i.test(t.name) || t.name === "NBA").flatMap((t) => t.events).filter((e) => e.estimateStartTime > FROM && e.estimateStartTime < TO);
const out = [];
for (const e of evs) {
  const id = e.eventId.replace("sr:match:", "");
  const mi = await get(`match_info/${id}`); const T = mi?.match?.teams; if (!T) continue;
  const games = {};
  for (const side of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[side].uid}/20`);
    games[side] = (d?.matches || []).filter((m) => m.result && m.result.home != null && (m.time?.uts || 0) > SINCE)
      .map((m) => { const me = m.teams.home.uid === T[side].uid; return { tot: m.result.home + m.result.away, mine: me ? m.result.home : m.result.away, opp: (me ? m.teams.away : m.teams.home).name, date: m.time.date }; });
  }
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${e.eventId}&productId=3`, { headers: H }).then((r) => r.json())).data;
  const lines = [];
  for (const m of ev.markets || []) {
    const mt = m.desc.match(/^(.*?)Over\/Under \(incl\. overtime\) ([\d.]+)$/); if (!mt) continue;
    const who = mt[1].trim(), line = +mt[2];
    const sample = who === "" ? [...games.home, ...games.away].map((g) => g.tot) : who.startsWith(e.homeTeamName.split(" ").pop()) || who.includes(e.homeTeamName) ? games.home.map((g) => g.mine) : who.includes(e.awayTeamName) ? games.away.map((g) => g.mine) : null;
    if (!sample || !sample.length) continue;
    for (const o of m.outcomes || []) {
      const over = /^Over/.test(o.desc), odds = +o.odds;
      if (!(odds >= 1.2 && odds < 1.4)) continue;
      const hit = sample.filter((v) => over ? v > line : v < line).length;
      lines.push({ label: `${who || "Total"} ${o.desc}`, odds, hit, n: sample.length });
    }
  }
  lines.sort((a, b) => b.hit / b.n - a.hit / a.n || b.odds - a.odds);
  out.push({ t: e.estimateStartTime, game: `${e.homeTeamName} v ${e.awayTeamName}`, nH: games.home.length, nA: games.away.length,
    avg: Math.round([...games.home, ...games.away].reduce((s, g) => s + g.tot, 0) / Math.max(1, games.home.length + games.away.length)),
    home: games.home.map((g) => `${g.mine}(${g.tot})`).join(" "), away: games.away.map((g) => `${g.mine}(${g.tot})`).join(" "), best: lines.filter((l) => l.hit / l.n >= 0.85).slice(0, 6) });
}
for (const g of out) {
  console.log(`\n${new Date(g.t + 3600e3).toISOString().slice(5, 16).replace("T", " ")} ${g.game} | games this season ${g.nH}/${g.nA} | avg combined ${g.avg}`);
  console.log("  home pts(total):", g.home); console.log("  away pts(total):", g.away);
  for (const l of g.best) console.log(`  ✓ ${l.label} @${l.odds} — cleared ${l.hit}/${l.n}`);
  if (!g.best.length) console.log("  (no line at 1.20-1.39 cleared 85%+)");
}
