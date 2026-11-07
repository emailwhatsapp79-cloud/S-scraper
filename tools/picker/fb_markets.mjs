// Football, every market (owner, 8 Nov: "don't limit it"): each outcome
// SportyBet prices that can be judged from a final and half-time score is
// tested on both teams' last 10: double chance, 1X2, 1UP/2UP, every
// over/under (match, team, halves), GG/NG, every combo (1X2 or double chance
// with over/under or GG, "team or over 2.5", "team or GG", "team or clean
// sheet"), multigoals, goal bounds, excluded goals, clean sheet, win to nil,
// win either / both halves, goal in both halves, handicaps.
//
// Same rules as fb_lines.mjs: last 10 each (85%+ combined and 80%+ each
// side), price 1.20-1.39 or 1.15-1.19 at 90%+, head-to-head only drops a
// line, the owner's under rule, live coverage flag. Overs need 95%+
// (review, 8 Nov: our over legs won 59-78% against 85-95% on paper; every
// lost over 1.5 finished 1-0).
//
// Run: node fb_markets.mjs <eventId> ...   (prints the best lines per game)
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };

import { judge } from "../../site/api/_markets.js";
const yes = (o) => o.desc === "Yes";

const label = (m, o) => `${m.desc.trim()}: ${o.desc}`;
// "Needs goals": a line a 0-0 would lose (over, to score, GG, no clean sheet,
// multigoals from 1). These carry the 95% bar from the over review.
const needsGoals = (f) => f({ H: 0, A: 0, hH: 0, hA: 0 }) === false;

const out = [];
for (const eid of process.argv.slice(2)) {
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eid}&productId=3`, { headers: H }).then((r) => r.json())).data;
  if (!ev || ev.matchStatus !== "Not start") continue;
  const mi = await get(`match_info/${eid.replace("sr:match:", "")}`); const T = mi?.match?.teams; if (!T) continue;
  const noLive = Number(mi?.match?.coverage?.lmtsupport ?? 0) <= 1;
  const sample = {};
  for (const s of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[s].uid}/10`);
    sample[s] = (d?.matches || []).filter((m) => m.result?.home != null).slice(0, 10).map((m) => {
      const me = m.teams.home.uid === T[s].uid, p1 = m.periods?.p1;
      const f = me ? m.result.home : m.result.away, a = me ? m.result.away : m.result.home;
      const hf = p1 ? (me ? p1.home : p1.away) : null, ha = p1 ? (me ? p1.away : p1.home) : null;
      // The home team's games read as "home side = this team"; the away team's as "away side = this team".
      return s === "home" ? { H: f, A: a, hH: hf, hA: ha } : { H: a, A: f, hH: ha, hA: hf };
    });
  }
  const vs = await get(`stats_team_versus/${T.home.uid}/${T.away.uid}`);
  const h2h = (vs?.matches || []).filter((m) => m.result?.home != null && !m.walkover).slice(0, 8).map((m) => {
    const me = m.teams.home.uid === T.home.uid, p1 = m.periods?.p1;
    return { H: me ? m.result.home : m.result.away, A: me ? m.result.away : m.result.home, hH: p1 ? (me ? p1.home : p1.away) : null, hA: p1 ? (me ? p1.away : p1.home) : null,
      recent: (m.time?.uts || 0) * 1000 > Date.now() - 2 * 365 * 86400e3 };
  });
  const x12 = (ev.markets || []).find((m) => String(m.id) === "1");
  const pr = (d) => +((x12?.outcomes || []).find((o) => o.desc === d)?.odds || 99);
  const hp = pr("Home"), ap = pr("Away");
  const fav = hp < ap ? "home" : "away", favName = fav === "home" ? ev.homeTeamName : ev.awayTeamName;
  const strongWeak = Math.min(hp, ap) <= 1.7 || Math.max(hp, ap) >= 4;
  const favScores = sample[fav].filter((x) => (fav === "home" ? x.H : x.A) >= 2).length >= 5;
  const lines = [];
  for (const m of ev.markets || []) {
    for (const o of m.outcomes || []) {
      const odds = +o.odds; if (!(odds >= 1.15 && odds < 1.4) || o.isActive === 0) continue;
      const f = judge(m, o); if (!f) continue;
      const hs = sample.home.map(f).filter((v) => v != null), as = sample.away.map(f).filter((v) => v != null);
      if (hs.length < 8 || as.length < 8) continue;
      const hh = hs.filter(Boolean).length, ah = as.filter(Boolean).length, n = hs.length + as.length, hit = hh + ah;
      const over = needsGoals(f), need = over ? 0.95 : odds < 1.2 ? 0.9 : 0.85;
      if (hit / n < need || hh / hs.length < 0.8 || ah / as.length < 0.8) continue;
      // Owner's under rule: strong v weak, or a favourite that likes scoring -> no
      // under on the total or on the favourite's goals.
      const lab = label(m, o);
      const mid = String(m.id);
      const underTotal = (/Under/.test(o.desc) && ["18", "68", "90", "37", "547", "36"].includes(mid)) || (["855", "857", "859"].includes(mid) && yes(o));
      const underFav = /Under/.test(o.desc) && m.desc.includes(favName);
      if ((strongWeak || favScores) && (underTotal || underFav)) continue;
      const hv = h2h.map((x) => ({ ...x, ok: f(x) })).filter((x) => x.ok != null);
      const bR = hv.filter((x) => x.recent && !x.ok).length, bA = hv.filter((x) => !x.ok).length;
      if (bR >= 2 || bA >= 3) continue;
      const rec = hv.filter((x) => x.recent).length;
      lines.push({ lab, odds, hit, n, hh, hn: hs.length, ah, an: as.length, h2h: hv.length ? `${hv.length - bA}/${hv.length}${rec < 3 ? " (thin)" : ""}` : "never met",
        mid: String(m.id), mdesc: m.desc.trim() + (m.specifier && !/[\d.]+$/.test(m.desc.trim()) ? ` [${m.specifier}]` : ""), odesc: o.desc, over });
    }
  }
  lines.sort((a, b) => b.hit / b.n - a.hit / a.n || b.odds - a.odds);
  const t = new Date(ev.estimateStartTime + 3600e3).toISOString().slice(11, 16);
  out.push({ eid, t, game: `${ev.homeTeamName} v ${ev.awayTeamName}`, league: ev.sport.category.tournament.name, noLive, lines });
  console.log(`\n${t} ${ev.homeTeamName} v ${ev.awayTeamName} (${ev.sport.category.name} ${ev.sport.category.tournament.name})${noLive ? " ⚠️ no live coverage" : ""}`);
  for (const l of lines.slice(0, 8)) console.log(`  ✓ ${l.lab} @${l.odds} — ${l.hit}/${l.n} (${l.hh}/${l.hn} · ${l.ah}/${l.an}) | h2h ${l.h2h}`);
  if (!lines.length) console.log("  (nothing passed)");
}
if (process.env.OUT) (await import("fs")).writeFileSync(process.env.OUT, JSON.stringify(out));
