// Football: which goal, first-half, corner, double-chance and draw-no-bet lines
// each team's last 10 cleared (owner, 3 Nov: last 10 only; 20 games gave
// false percentages).
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const ids = process.argv.slice(2);
for (const eid of ids) {
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eid}&productId=3`, { headers: H }).then((r) => r.json())).data;
  if (!ev || ev.matchStatus !== "Not start") continue;
  const mi = await get(`match_info/${eid.replace("sr:match:", "")}`); const T = mi?.match?.teams; if (!T) continue;
  // Owner's rule (3 Nov, Bracknell v Chertsey): a game with no live coverage
  // (Sportradar lmtsupport 1 or less) shows "not started" all game on SportyBet
  // and blocks the whole slip's cash-out until it settles.
  const noLive = Number(mi?.match?.coverage?.lmtsupport ?? 0) <= 1;
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
  const g10 = { home: g.home.slice(0, 10), away: g.away.slice(0, 10) };
  // Owner's rule (29 Oct, Braga v Famalicao): also check the two teams' meetings.
  const vs = await get(`stats_team_versus/${T.home.uid}/${T.away.uid}`);
  const h2h = (vs?.matches || []).filter((m) => m.result && m.result.home != null && !m.walkover).slice(0, 8).map((m) => {
    const me = m.teams.home.uid === T.home.uid, p1 = m.periods?.p1;
    return { h: me ? m.result.home : m.result.away, a: me ? m.result.away : m.result.home, hh: p1 ? (me ? p1.home : p1.away) : null, ha: p1 ? (me ? p1.away : p1.home) : null,
      recent: (m.time?.uts || 0) * 1000 > Date.now() - 2 * 365 * 86400e3 };
  });
  // Owner's rule (30 Oct): meetings older than 2 years count less (squads and
  // coaches change). Two recent breaks drop the line; old breaks only count
  // when three or more breaks in all.
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
    if (label.startsWith(`Win: ${ev.homeTeamName}`)) return x.h > x.a;
    if (label.startsWith(`Win: ${ev.awayTeamName}`)) return x.a > x.h;
    if (label.startsWith("Draw no bet")) return label.endsWith(ev.homeTeamName) ? x.h >= x.a : x.a >= x.h;
    return true;
  };
  const x12 = (ev.markets || []).find((m) => String(m.id) === "1");
  const pr = (d) => +((x12?.outcomes || []).find((o) => o.desc === d)?.odds || 99);
  const blocked = (label) => {
    // Owner's rule (30 Oct, Seraing v Liege 1-0): a total over needs both
    // attacks; neither side may have failed to score in more than 2 of its last 10.
    if (/^Total goals Over/.test(label)) return g10.home.filter((x) => x.f === 0).length > 2 || g10.away.filter((x) => x.f === 0).length > 2;
    if (!/Under/.test(label)) return false;
    // Owner's under rule (1 Nov, replacing the 4.5-only, weak-attack and cup
    // rules): no under where the favourite is strong and likes scoring.
    //  - Strong v weak (favourite at 1.70 or shorter, or underdog at 4.00 or
    //    longer, or a high scorer against a leaky defence): no total or
    //    first-half total under and no under on the favourite's goals; an
    //    under on the weak team's goals is fine.
    //  - A favourite that likes scoring (2+ goals in 5 of its last 10): no
    //    total under and no under on its goals; look at its over instead.
    // Every other under (balanced games) is judged on the numbers alone.
    const hp = pr("Home"), ap = pr("Away"), priced = hp < 99 && ap < 99;
    const runUp = (me, op) => me.filter((x) => x.f >= 3).length >= 3 && op.filter((x) => x.a >= 3).length >= 3;
    const strongWeak = (priced && (Math.min(hp, ap) <= 1.7 || Math.max(hp, ap) >= 4)) || runUp(g10.home, g10.away) || runUp(g10.away, g10.home);
    const fav = priced && hp !== ap ? (hp < ap ? "home" : "away") : null;
    const favName = fav ? (fav === "home" ? ev.homeTeamName : ev.awayTeamName) : null;
    const favScores = fav ? g10[fav].filter((x) => x.f >= 2).length >= 5 : false;
    const total = /^Total goals|^1st half goals/.test(label);
    const onFav = favName && (label.startsWith(favName + " goals") || label.startsWith("1st half " + favName + " goals"));
    if ((strongWeak || favScores) && (total || onFav)) return true;
    return false;
  };
  const res = [];
  // Owner's rule (30 Oct, Colo-Colo 6-1): on one team's goals, each half of
  // the sample must clear 80% on its own (the team's goals for, and the
  // opponent's goals against), so a strong record can't hide a leaky defence.
  const test = (label, odds, hits, n, parts) => {
    // Owner (1 Nov): back to the first-day window, 1.20-1.39 at 85%+.
    // Owner (4 Nov, Real Madrid): a 1.15-1.19 line may pass too when it
    // cleared 90%+, so big teams' strong lines aren't lost to the price floor.
    const short = odds >= 1.15 && odds < 1.2;
    if (!((odds >= 1.2 && odds < 1.4) || short) || !n || blocked(label)) return;
    if (short && hits / n < 0.9) return;
    if (parts && parts.some(([h, k]) => k && h / k < 0.8)) return;
    const rec = h2h.filter((x) => x.recent), old = h2h.filter((x) => !x.recent);
    const bR = rec.filter((x) => !holds(label, x)).length, bO = old.filter((x) => !holds(label, x)).length;
    if (bR >= 2 || bR + bO >= 3) return;
    const h2hTxt = !h2h.length ? "never met" : `${rec.length - bR}/${rec.length} last 2y` + (old.length ? `, ${old.length - bO}/${old.length} older` : "") + (rec.length < 3 ? " (thin)" : "");
    res.push({ label, odds, hit: hits, n, h2h: h2hTxt, cleanH2h: bR === 0 && rec.length >= 3, warn: short ? "short price (1.15-1.19, needs 90%+)" : "" });
  };
  const scan = (g, test) => {
    const all = [...g.home, ...g.away];
    for (const m of ev.markets || []) {
      const tot = /total=([\d.]+)/.exec(m.specifier || "")?.[1];
      for (const o of m.outcomes || []) {
        const odds = +o.odds, over = /^Over/.test(o.desc);
        cur = { tot: +tot, over, desc: o.desc };
        if (m.id === "18" && tot) test(`Total goals ${o.desc}`, odds, all.filter((x) => over ? x.tot > +tot : x.tot < +tot).length, all.length);
        if (m.id === "19" && tot) { const a = g.home.filter((x) => over ? x.f > +tot : x.f < +tot).length, b = g.away.filter((x) => over ? x.a > +tot : x.a < +tot).length; test(`${ev.homeTeamName} goals ${o.desc}`, odds, a + b, all.length, [[a, g.home.length], [b, g.away.length]]); }
        if (m.id === "20" && tot) { const a = g.away.filter((x) => over ? x.f > +tot : x.f < +tot).length, b = g.home.filter((x) => over ? x.a > +tot : x.a < +tot).length; test(`${ev.awayTeamName} goals ${o.desc}`, odds, a + b, all.length, [[a, g.away.length], [b, g.home.length]]); }
        // Owner's rule (31 Oct): straight wins count too when they pass.
        if (m.id === "1" && (o.desc === "Home" || o.desc === "Away")) {
          const side = o.desc === "Home" ? "home" : "away", other = side === "home" ? "away" : "home";
          test(`Win: ${side === "home" ? ev.homeTeamName : ev.awayTeamName}`, odds, g[side].filter((x) => x.f > x.a).length + g[other].filter((x) => x.f < x.a).length, all.length);
        }
        if (m.id === "10") {
          if (o.desc === "Home or Draw") test("Double chance: " + ev.homeTeamName + " or draw", odds, g.home.filter((x) => x.f >= x.a).length + g.away.filter((x) => x.f <= x.a).length, all.length);
          if (o.desc === "Draw or Away") test("Double chance: " + ev.awayTeamName + " or draw", odds, g.away.filter((x) => x.f >= x.a).length + g.home.filter((x) => x.f <= x.a).length, all.length);
        }
        const H1 = all.filter((x) => x.hf != null), CK = all.filter((x) => x.cf != null);
        if (m.id === "68" && tot) test(`1st half goals ${o.desc}`, odds, H1.filter((x) => over ? x.hf + x.ha > +tot : x.hf + x.ha < +tot).length, H1.length);
        if (m.id === "69" && tot) { const a = g.home.filter((x) => x.hf != null && (over ? x.hf > +tot : x.hf < +tot)).length, b = g.away.filter((x) => x.ha != null && (over ? x.ha > +tot : x.ha < +tot)).length; test(`1st half ${ev.homeTeamName} goals ${o.desc}`, odds, a + b, H1.length, [[a, g.home.filter((x) => x.hf != null).length], [b, g.away.filter((x) => x.ha != null).length]]); }
        if (m.id === "70" && tot) { const a = g.away.filter((x) => x.hf != null && (over ? x.hf > +tot : x.hf < +tot)).length, b = g.home.filter((x) => x.ha != null && (over ? x.ha > +tot : x.ha < +tot)).length; test(`1st half ${ev.awayTeamName} goals ${o.desc}`, odds, a + b, H1.length, [[a, g.away.filter((x) => x.hf != null).length], [b, g.home.filter((x) => x.ha != null).length]]); }
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
  };
  scan(g10, test);
  // Same hit rate: the line with more room first (owner's rule after Leverkusen).
  res.sort((a, b) => b.hit / b.n - a.hit / a.n || a.odds - b.odds);
  const t = new Date(ev.estimateStartTime + 3600e3).toISOString().slice(11, 16);
  console.log(`\n${t} ${ev.homeTeamName} v ${ev.awayTeamName} (${ev.sport.category.tournament.name})`);
  console.log(`  ${ev.homeTeamName} last ${g10.home.length}: ${g10.home.map((x) => x.f + "-" + x.a).join(" ")}`);
  console.log(`  ${ev.awayTeamName} last ${g10.away.length}: ${g10.away.map((x) => x.f + "-" + x.a).join(" ")}`);
  if (!process.env.NO_CORNERS) console.log(`  corners for-against: ${ev.homeTeamName} ${g10.home.map((x) => x.cf + "-" + x.ca).join(" ")} | ${ev.awayTeamName} ${g10.away.map((x) => x.cf + "-" + x.ca).join(" ")}`);
  const good = res.filter((r) => r.n >= 12 && r.hit / r.n >= 0.85).slice(0, 6);
  for (const r of good) console.log(`  ✓ ${r.label} @${r.odds} — ${r.hit}/${r.n} | h2h ${r.h2h}${r.warn ? " | " + r.warn : ""}${noLive ? " | ⚠️ no live coverage (blocks cash-out)" : ""}`);
  if (!good.length) console.log("  (nothing at 1.20-1.39 cleared 85%+, or 1.15-1.19 at 90%+)");
}
