// Deep check for the pool: each team's last 10 on the exact line (85%+ combined,
// 80%+ each side, so one team's good record can't carry the other), and for
// overs: neither team blanked in more than 2 of 10 (owner, 3 Nov: last 10 only).
import fs from "fs";
const B = "https://lsc.fn.sportradar.com/sportybet/en/Etc:UTC/gismo";
const get = async (p) => { try { return (await fetch(`${B}/${p}`, { headers: { "user-agent": "Mozilla/5.0 Chrome/122" } }).then((r) => r.json()))?.doc?.[0]?.data; } catch { return null; } };
const pool = JSON.parse(fs.readFileSync("pool.json"));
const out = [];
for (const x of pool) {
  const T = (await get(`match_info/${x.eid.replace("sr:match:", "")}`))?.match?.teams; if (!T) continue;
  const g = {};
  for (const s of ["home", "away"]) {
    const d = await get(`stats_team_lastx/${T[s].uid}/10`);
    g[s] = (d?.matches || []).filter((m) => m.result?.home != null).slice(0, 10).map((m) => { const me = m.teams.home.uid === T[s].uid; const p1 = m.periods?.p1; return { f: me ? m.result.home : m.result.away, a: me ? m.result.away : m.result.home, hf: p1 ? (me ? p1.home : p1.away) : null, ha: p1 ? (me ? p1.away : p1.home) : null }; });
  }
  const [hn, an] = x.game.split(" v ");
  const lab = x.label; let mt, hs, as, notes = [];
  const rate = (arr, fn) => arr.filter(fn).length / Math.max(1, arr.length);
  if ((mt = lab.match(/^Total goals (Over|Under) ([\d.]+)$/))) {
    const o = mt[1] === "Over", L = +mt[2], fn = (v) => o ? v.f + v.a > L : v.f + v.a < L;
    hs = rate(g.home, fn); as = rate(g.away, fn);
    if (o) { const bh = g.home.filter((v) => v.f === 0).length, ba = g.away.filter((v) => v.f === 0).length; if (Math.max(bh, ba) > 2) notes.push(`blanks ${bh}/${ba}`); }
  } else if ((mt = lab.match(/^1st half goals Under ([\d.]+)$/))) {
    const L = +mt[1], fn = (v) => v.hf != null && v.hf + v.ha < L, ok = (v) => v.hf != null;
    hs = g.home.filter(fn).length / Math.max(1, g.home.filter(ok).length); as = g.away.filter(fn).length / Math.max(1, g.away.filter(ok).length);
  } else if ((mt = lab.match(/^1st half (.*) goals (Over|Under) ([\d.]+)$/))) {
    const o = mt[2] === "Over", L = +mt[3], home = mt[1] === hn;
    const me = (home ? g.home : g.away).filter((v) => v.hf != null), op = (home ? g.away : g.home).filter((v) => v.ha != null);
    hs = me.filter((v) => o ? v.hf > L : v.hf < L).length / Math.max(1, me.length); as = op.filter((v) => o ? v.ha > L : v.ha < L).length / Math.max(1, op.length);
  } else if ((mt = lab.match(/^1st half goals Over ([\d.]+)$/))) {
    const L = +mt[1], fn = (v) => v.hf != null && v.hf + v.ha > L, ok = (v) => v.hf != null;
    hs = g.home.filter(fn).length / Math.max(1, g.home.filter(ok).length); as = g.away.filter(fn).length / Math.max(1, g.away.filter(ok).length);
  } else if ((mt = lab.match(/^(.*) goals (Over|Under) ([\d.]+)$/))) {
    const o = mt[2] === "Over", L = +mt[3], home = mt[1] === hn;
    const me = home ? g.home : g.away, op = home ? g.away : g.home;
    hs = rate(me, (v) => o ? v.f > L : v.f < L); as = rate(op, (v) => o ? v.a > L : v.a < L);
  } else if ((mt = lab.match(/^Double chance: (.*) or draw$/))) {
    const home = mt[1] === hn, me = home ? g.home : g.away, op = home ? g.away : g.home;
    hs = rate(me, (v) => v.f >= v.a); as = rate(op, (v) => v.f <= v.a);
  } else if ((mt = lab.match(/^Win: (.*)$/))) {
    const home = mt[1] === hn, me = home ? g.home : g.away, op = home ? g.away : g.home;
    hs = rate(me, (v) => v.f > v.a); as = rate(op, (v) => v.f < v.a);
  } else { notes.push("unchecked market"); hs = as = 0; }
  const comb = (hs + as) / 2;
  if (comb < 0.85) notes.push(`last10 ${Math.round(comb * 100)}%`);
  if (Math.min(hs, as) < 0.8) notes.push(`one side ${Math.round(Math.min(hs, as) * 100)}%`);
  out.push({ ...x, l20: Math.round(comb * 100), ok: !notes.length, notes: notes.join("; ") });
}
fs.writeFileSync("pool_checked.json", JSON.stringify(out, null, 0));
for (const x of out) console.log(`${x.ok ? "OK " : "OUT"} ${x.t} ${x.game.slice(0, 45).padEnd(45)} | ${x.label} @${x.odds} | 10g ${x.h} l20 ${x.l20}% h2h ${x.h2h} ${x.notes}`);
