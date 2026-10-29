const API = "https://tabletennis.setkacup.com/api";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", Accept: "application/json", Referer: "https://tabletennis.setkacup.com/" };
const get = async (p) => { try { const r = await fetch(API + p, { headers: H }); return r.ok ? await r.json() : null; } catch { return null; } };
const find = async (ln, fn) => Object.values((await get(`/Players/en/paged?filter=${encodeURIComponent(ln)}&count=30&page=1`))?.players || {}).flat().find((p) => p.lastName.toLowerCase() === ln.toLowerCase() && (!fn || p.firstName.toLowerCase().startsWith(fn.toLowerCase())));
const lag = (s) => new Date(Date.parse(s) + 3600e3).toISOString().slice(5, 16).replace("T", " ");
async function recent(p, n = 12) {
  const pd = await get(`/Players/en/${p.id}`);
  const tids = (pd?.tournamentStats || []).filter((t) => Date.parse(t.startDate) < Date.now()).sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate)).slice(0, 4).map((t) => t.id);
  const out = [];
  for (const tid of tids) for (const m of (await get(`/Matches/en?tournamentId=${tid}`)) || []) {
    if (m.statusId !== 3 || !m.setScores?.length) continue;
    const me1 = m.player1?.id === p.id; if (!me1 && m.player2?.id !== p.id) continue;
    const sets = m.setScores.sort((x,y)=>x.number-y.number).map((s) => me1 ? `${s.p1Score}-${s.p2Score}` : `${s.p2Score}-${s.p1Score}`);
    const w = sets.filter((s) => +s.split("-")[0] > +s.split("-")[1]).length;
    out.push({ t: m.startDate, txt: `${lag(m.startDate)} ${w > sets.length - w ? "W" : "L"} ${w}-${sets.length - w} v ${(me1 ? m.player2 : m.player1)?.lastName} [${sets.join(" ")}]` });
  }
  return out.sort((a, b) => Date.parse(b.t) - Date.parse(a.t)).slice(0, n);
}
const [a1, a2, b1, b2] = process.argv.slice(2);
const A = await find(a1, a2), Bp = await find(b1, b2);
console.log(`\n== ${A?.lastName} ${A?.firstName} (#${A?.id}) v ${Bp?.lastName} ${Bp?.firstName} (#${Bp?.id})`);
const c = await get(`/Players/en/compare?player1Id=${A.id}&player2Id=${Bp.id}`);
const ms = (c?.matches || c?.lastMatches || []);
console.log("  compare keys:", Object.keys(c || {}).join(","));
for (const m of ms.filter((m) => m.statusId === 3).slice(0, 10)) {
  const me1 = m.player1?.id === A.id;
  const sets = (m.setScores || []).sort((x,y)=>x.number-y.number).map((s) => me1 ? `${s.p1Score}-${s.p2Score}` : `${s.p2Score}-${s.p1Score}`);
  const w = sets.filter((s) => +s.split("-")[0] > +s.split("-")[1]).length;
  console.log(`   h2h ${lag(m.startDate)} ${A.lastName} ${w}-${sets.length - w} [${sets.join(" ")}]`);
}
for (const p of [A, Bp]) { console.log(`  ${p.lastName} recent:`); for (const r of await recent(p)) console.log("    " + r.txt); }
