// Setka TT picks without our database: SportyBet card + the official Setka site
// (head-to-head with set points, each player's recent matches).
process.env.DATABASE_URL ||= "postgres://u:p@localhost/db"; // _tt.js opens a client on import; no query runs here
const { fetchTTCard, normalise, nameKey } = await import(process.cwd() + "/api/_tt.js");
const fs = await import("node:fs");
const WATCH = fs.readFileSync(process.cwd() + "/api/_tt_watch.js", "utf8").match(/const WATCH = \[([\s\S]*?)\];/)[1].match(/"([^"]+)"/g).map((s) => nameKey(s.slice(1, -1)));
const API = "https://tabletennis.setkacup.com/api";
const HS = { "User-Agent": "Mozilla/5.0 Chrome/120", Accept: "application/json", Referer: "https://tabletennis.setkacup.com/" };
const get = async (p) => { for (let i = 0; i < 2; i++) { try { const r = await fetch(API + p, { headers: HS }); if (r.ok) return await r.json(); } catch {} } return null; };
const ids = new Map(), women = new Set();
async function pid(name) {
  const k = nameKey(name); if (ids.has(k)) return ids.get(k);
  const d = await get(`/Players/en/paged?filter=${encodeURIComponent(name.split(",")[0].trim())}&count=30&page=1`);
  const h = Object.values(d?.players || {}).flat().find((p) => nameKey(p.lastName + ", " + p.firstName) === k);
  ids.set(k, h ? h.id : null); if (h && h.gender === false) women.add(h.id); return h ? h.id : null;
}
const formCache = new Map();
async function recent(id) { // last matches (newest first) with set points, from the player's last 3 tournaments
  if (formCache.has(id)) return formCache.get(id);
  const pd = await get(`/Players/en/${id}`);
  const tids = (pd?.tournamentStats || []).filter((t) => Date.parse(t.startDate) < Date.now()).sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate)).slice(0, 3).map((t) => t.id);
  const out = [];
  for (const tid of tids) {
    const a = await get(`/Matches/en?tournamentId=${tid}`);
    for (const m of Array.isArray(a) ? a : []) {
      if (m.statusId !== 3 || m.technicalResult) continue;
      const me1 = m.player1?.id === id; if (!me1 && m.player2?.id !== id) continue;
      const w = me1 ? +m.player1Score : +m.player2Score, l = me1 ? +m.player2Score : +m.player1Score;
      const sets = (m.setScores || []).sort((x, y) => x.number - y.number).map((x) => me1 ? [x.p1Score, x.p2Score] : [x.p2Score, x.p1Score]);
      out.push({ t: Date.parse(m.startDate), w, l, sets, opp: me1 ? m.player2.lastName : m.player1.lastName });
    }
  }
  out.sort((a, b) => b.t - a.t); formCache.set(id, out); return out;
}
const H = Number(process.argv[2] || 4);
const { events } = await fetchTTCard();
const games = events.map(normalise).filter((g) => /setka/i.test(g.tourn || "") && g.start > Date.now() + 2 * 60e3 && g.start < Date.now() + H * 3600e3 && g.win && g.win.home > 1);
const rows = [];
for (const g of games) {
  const favHome = +g.win.home <= +g.win.away;
  const P = favHome ? g.home : g.away, O = favHome ? g.away : g.home, price = +(favHome ? g.win.home : g.win.away), other = +(favHome ? g.win.away : g.win.home);
  if (price < 1.2 || price >= 1.4) continue;
  const why = [];
  if (WATCH.includes(nameKey(P)) || WATCH.includes(nameKey(O))) why.push("watch list");
  const [p, o] = [await pid(P), await pid(O)];
  if (!p || !o) { rows.push({ g, P, O, price, out: ["not found on Setka site"] }); continue; }
  if (women.has(p) || women.has(o)) continue; // owner's rule: no women's TT
  const c = await get(`/Players/en/compare?player1Id=${p}&player2Id=${o}`);
  const meet = (c?.matches || []).filter((m) => m.statusId === 3 && !m.technicalResult).map((m) => (m.player1.id === p ? +m.player1Score > +m.player2Score : +m.player2Score > +m.player1Score)).slice(0, 20);
  const h2w = meet.filter(Boolean).length, h2n = meet.length;
  const fp = (await recent(p)).slice(0, 10), fo = (await recent(o)).slice(0, 10);
  const fpw = fp.filter((m) => m.w > m.l).length, fow = fo.filter((m) => m.w > m.l).length;
  const dayStart = Math.floor((Date.now() + 3600e3) / 86400e3) * 86400e3 - 3600e3;
  const pToday = (await recent(p)).filter((m) => m.t >= dayStart), oToday = (await recent(o)).filter((m) => m.t >= dayStart);
  const last = fp[0];
  if (h2n === 0) why.push("never met");
  else if (h2n >= 3 && h2w / h2n < 0.6) why.push(`h2h only ${h2w}-${h2n - h2w}`);
  if (fp.length >= 5 && fpw / fp.length < 0.5) why.push(`form ${fpw}/${fp.length}`);
  if (pToday.some((m) => m.w === 0 && m.l === 3)) why.push("lost 0-3 today");
  if (last && last.sets.length && last.sets.some(([a, b]) => a > b) && last.sets.some(([a, b]) => a < b) && last.sets.every(([a, b]) => Math.abs(a - b) >= 4)) why.push("swing last match");
  const collapse = (await recent(p)).filter((m) => m.t > Date.now() - 3 * 86400e3).some((m) => m.sets.length >= 4 && m.sets.slice(0, 3).filter(([a, b]) => a > b).length === 2 && m.w < m.l);
  if (collapse) why.push("lost from 2-1 up in last 3 days");
  // A simple rating: half head-to-head (last 20), half the form gap (last 10 each).
  const h2r = h2n ? (h2w + 1) / (h2n + 2) : 0.5, fr = 0.5 + ((fp.length ? fpw / fp.length : 0.5) - (fo.length ? fow / fo.length : 0.5)) / 2;
  const pct = Math.round(100 * (0.5 * h2r + 0.5 * fr));
  const sb = Math.round(100 * (1 / price) / (1 / price + 1 / other));
  rows.push({ g, P, O, price, pct, sb, h2: `${h2w}-${h2n - h2w}`, fp: `${fpw}/${fp.length}`, fo: `${fow}/${fo.length}`, today: pToday.map((m) => (m.w > m.l ? "W" : "L") + m.w + "-" + m.l).join(" "), out: why });
}
rows.sort((a, b) => (a.out.length - b.out.length) || (b.pct || 0) - (a.pct || 0));
for (const r of rows) {
  const t = new Date(r.g.start + 3600e3).toISOString().slice(11, 16);
  console.log(`${r.out.length ? "OUT " : "OK  "}${t} ${r.P} @${r.price} v ${r.O.split(",")[0]} | rating ${r.pct ?? "-"}% SB ${r.sb ?? "-"}% | h2h ${r.h2 ?? "-"} | form ${r.fp ?? "-"} v ${r.fo ?? "-"} | today ${r.today || "-"}${r.out.length ? " | " + r.out.join("; ") : ""}`);
}
console.log("setka games at 1.20-1.39 in window:", rows.length, "of", games.length);
