// Football: which goal, first-half, corner, double-chance and draw-no-bet lines
// each team's last 10 cleared.
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const ids = process.argv.slice(2);
for (const eid of ids) {
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eid}&productId=3`, { headers: H }).then((r) => r.json())).data;
  if (!ev || ev.matchStatus !== "Not start") continue;
  const mi = await get(`match_info/${eid.replace("sr:match:", "")}`); const T = mi?.match?.teams; if (!T) continue;
  const g = {};
  for (const side of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[side].uid}/10`);
    const ms = (d?.matches || []).filter((m) => m.result && m.result.home != null);
    g[side] = await Promise.all(ms.map(async (m) => {
      const me = m.teams.home.uid === T[side].uid; const f = me ? m.result.home : m.result.away, a = me ? m.result.away : m.result.home;
      const p1 = m.periods?.p1; const hf = p1 ? (me ? p1.home : p1.away) : null, ha = p1 ? (me ? p1.away : p1.home) : null;
      const det = process.env.NO_CORNERS ? null : await get(`match_details/${m._id}`); const ck = det?.values?.["124"]?.value;
      const cf = ck ? (me ? ck.home : ck.away) : null, ca = ck ? (me ? ck.away : ck.home) : null;
      return { f, a, tot: f + a, hf, ha, cf, ca };
    }));
  }
  const all = [...g.home, ...g.away];
  // Owner's rule (29 Oct, Braga v Famalicao): also check the two teams' meetings.
  const vs = await get(`stats_team_versus/${T.home.uid}/${T.away.uid}`);
  const h2h = (vs?.matches || []).filter((m) => m.result && m.result.home != null && !m.walkover).slice(0, 8).map((m) => {
    const me = m.teams.home.uid === T.home.uid, p1 = m.periods?.p1;
    return { h: me ? m.result.home : m.result.away, a: me ? m.result.away : m.result.home, hh: p1 ? (me ? p1.home : p1.away) : null, ha: p1 ? (me ? p1.away : p1.home) : null };
  });
  let cur = {};
  const holds = (label, x) => {
    const { tot, over, desc } = cur, cmp = (v) => v == null ? true : over ? v > tot : v < tot;
    if (label.startsWith("Total goals")) return cmp(x.h + x.a);
    if (label.startsWith("1st half goals")) return cmp(x.hh == null ? null : x.hh + x.ha);
    if (label.startsWith(`1st half ${ev.homeTeamName} goals`)) return cmp(x.hh);
    if (label.startsWith(`1st half ${ev.awayTeamName} goals`)) return cmp(x.ha);
    if (label.startsWith(`${ev.homeTeamName} goals`)) return cmp(x.h);
    if (label.startsWith(`${ev.awayTeamName} goals`)) return cmp(x.a);
    if (label.startsWith(`Double chance: ${ev.homeTeamName}`)) return x.h >= x.a;
    if (label.startsWith(`Double chance: ${ev.awayTeamName}`)) return x.a >= x.h;
    if (label.startsWith("Both teams score")) return desc === "Yes" ? x.h > 0 && x.a > 0 : x.h === 0 || x.a === 0;
    if (label.startsWith("Draw no bet")) return label.endsWith(ev.homeTeamName) ? x.h >= x.a : x.a >= x.h;
    return true;
  };
  // Owner's rule (28 Oct, Leverkusen 5-2 v Nuremberg): in a cup tie with a big
  // favourite (1X2 price 1.40 or shorter), no total-goals under and no under on
  // the favourite's own goals. Their last 10 are against equals, not minnows.
  const cup = /cup|pokal|copa|coupe|coppa|trophy|taça|beker/i.test(ev.sport?.category?.tournament?.name || "");
  const x12 = (ev.markets || []).find((m) => String(m.id) === "1");
  const pr = (d) => +((x12?.outcomes || []).find((o) => o.desc === d)?.odds || 99);
  const bigFav = cup ? (pr("Home") <= 1.4 ? "home" : pr("Away") <= 1.4 ? "away" : null) : null;
  const blocked = (label) => bigFav && /Under/.test(label) && (/^Total goals|^1st half goals/.test(label) || label.startsWith((bigFav === "home" ? ev.homeTeamName : ev.awayTeamName) + " goals") || label.startsWith("1st half " + (bigFav === "home" ? ev.homeTeamName : ev.awayTeamName)));
  const res = [];
  const test = (label, odds, hits, n) => {
    if (!(odds >= 1.2 && odds < 1.4 && n) || blocked(label)) return;
    const broke = h2h.filter((x) => !holds(label, x)).length;
    if (broke >= 2) return; // broke it in 2+ of their last 8 meetings
    res.push({ label, odds, hit: hits, n, h2h: h2h.length ? `${h2h.length - broke}/${h2h.length}` : "never met" });
  };
  for (const m of ev.markets || []) {
    const tot = /total=([\d.]+)/.exec(m.specifier || "")?.[1];
    for (const o of m.outcomes || []) {
      const odds = +o.odds, over = /^Over/.test(o.desc);
      cur = { tot: +tot, over, desc: o.desc };
      if (m.id === "18" && tot) test(`Total goals ${o.desc}`, odds, all.filter((x) => over ? x.tot > +tot : x.tot < +tot).length, all.length);
      if (m.id === "19" && tot) test(`${ev.homeTeamName} goals ${o.desc}`, odds, g.home.filter((x) => over ? x.f > +tot : x.f < +tot).length + g.away.filter((x) => over ? x.a > +tot : x.a < +tot).length, all.length);
      if (m.id === "20" && tot) test(`${ev.awayTeamName} goals ${o.desc}`, odds, g.away.filter((x) => over ? x.f > +tot : x.f < +tot).length + g.home.filter((x) => over ? x.a > +tot : x.a < +tot).length, all.length);
      if (m.id === "10") {
        if (o.desc === "Home or Draw") test("Double chance: " + ev.homeTeamName + " or draw", odds, g.home.filter((x) => x.f >= x.a).length + g.away.filter((x) => x.f <= x.a).length, all.length);
        if (o.desc === "Draw or Away") test("Double chance: " + ev.awayTeamName + " or draw", odds, g.away.filter((x) => x.f >= x.a).length + g.home.filter((x) => x.f <= x.a).length, all.length);
      }
      const H1 = all.filter((x) => x.hf != null), CK = all.filter((x) => x.cf != null);
      if (m.id === "68" && tot) test(`1st half goals ${o.desc}`, odds, H1.filter((x) => over ? x.hf + x.ha > +tot : x.hf + x.ha < +tot).length, H1.length);
      if (m.id === "69" && tot) test(`1st half ${ev.homeTeamName} goals ${o.desc}`, odds, g.home.filter((x) => x.hf != null && (over ? x.hf > +tot : x.hf < +tot)).length + g.away.filter((x) => x.ha != null && (over ? x.ha > +tot : x.ha < +tot)).length, H1.length);
      if (m.id === "70" && tot) test(`1st half ${ev.awayTeamName} goals ${o.desc}`, odds, g.away.filter((x) => x.hf != null && (over ? x.hf > +tot : x.hf < +tot)).length + g.home.filter((x) => x.ha != null && (over ? x.ha > +tot : x.ha < +tot)).length, H1.length);
      if (m.id === "166" && tot) test(`Corners ${o.desc}`, odds, CK.filter((x) => over ? x.cf + x.ca > +tot : x.cf + x.ca < +tot).length, CK.length);
      if (m.id === "900300" && tot) test(`${ev.homeTeamName} corners ${o.desc}`, odds, g.home.filter((x) => x.cf != null && (over ? x.cf > +tot : x.cf < +tot)).length + g.away.filter((x) => x.ca != null && (over ? x.ca > +tot : x.ca < +tot)).length, CK.length);
      if (m.id === "900301" && tot) test(`${ev.awayTeamName} corners ${o.desc}`, odds, g.away.filter((x) => x.cf != null && (over ? x.cf > +tot : x.cf < +tot)).length + g.home.filter((x) => x.ca != null && (over ? x.ca > +tot : x.ca < +tot)).length, CK.length);
      if (m.id === "11") {
        // Draw no bet: a draw is a refund, so the rate is wins over decided games.
        const side = o.desc === "Home" ? "home" : "away", other = side === "home" ? "away" : "home";
        const w = g[side].filter((x) => x.f > x.a).length + g[other].filter((x) => x.f < x.a).length;
        const l = g[side].filter((x) => x.f < x.a).length + g[other].filter((x) => x.f > x.a).length;
        test(`Draw no bet: ${side === "home" ? ev.homeTeamName : ev.awayTeamName}`, odds, w, w + l);
      }
      if (m.id === "29") test(`Both teams score: ${o.desc}`, odds, all.filter((x) => o.desc === "Yes" ? x.f > 0 && x.a > 0 : x.f === 0 || x.a === 0).length, all.length);
    }
  }
  // Same hit rate: the line with more room first (owner's rule after Leverkusen).
  res.sort((a, b) => b.hit / b.n - a.hit / a.n || a.odds - b.odds);
  const t = new Date(ev.estimateStartTime + 3600e3).toISOString().slice(11, 16);
  console.log(`\n${t} ${ev.homeTeamName} v ${ev.awayTeamName} (${ev.sport.category.tournament.name})${bigFav ? " [cup mismatch: no unders on the favourite / total]" : ""}`);
  console.log(`  ${ev.homeTeamName} last ${g.home.length}: ${g.home.map((x) => x.f + "-" + x.a).join(" ")}`);
  console.log(`  ${ev.awayTeamName} last ${g.away.length}: ${g.away.map((x) => x.f + "-" + x.a).join(" ")}`);
  console.log(`  corners for-against: ${ev.homeTeamName} ${g.home.map((x) => x.cf + "-" + x.ca).join(" ")} | ${ev.awayTeamName} ${g.away.map((x) => x.cf + "-" + x.ca).join(" ")}`);
  const good = res.filter((r) => r.n >= 12 && r.hit / r.n >= 0.85).slice(0, 6);
  for (const r of good) console.log(`  ✓ ${r.label} @${r.odds} — ${r.hit}/${r.n} | h2h ${r.h2h}`);
  if (!good.length) console.log("  (nothing at 1.20-1.39 cleared 85%+)");
}
