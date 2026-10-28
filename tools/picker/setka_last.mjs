// A Setka player's last finished match with set points, from the official feed.
const API = "https://tabletennis.setkacup.com/api";
const H = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36", Accept: "application/json", Referer: "https://tabletennis.setkacup.com/" };
const get = async (p) => { try { const r = await fetch(API + p, { headers: H }); return r.ok ? await r.json() : null; } catch { return null; } };
export async function lastSetkaMatch(name, nameKey, before = Date.now()) {
  const ln = name.split(",")[0].trim();
  const d = await get(`/Players/en/paged?filter=${encodeURIComponent(ln)}&count=30&page=1`);
  const list = Object.values(d?.players || {}).flat();
  const hit = list.find((p) => nameKey(p.lastName + ", " + p.firstName) === nameKey(name));
  if (!hit) return null;
  const pd = await get(`/Players/en/${hit.id}`);
  const tids = (pd?.tournamentStats || []).filter((t) => Date.parse(t.startDate) < before).sort((a, b) => Date.parse(b.startDate) - Date.parse(a.startDate)).slice(0, 2).map((t) => t.id);
  let best = null;
  for (const tid of tids) {
    const a = await get(`/Matches/en?tournamentId=${tid}`);
    for (const m of Array.isArray(a) ? a : []) {
      if (m.statusId !== 3 || m.technicalResult || !m.setScores?.length) continue;
      const me1 = m.player1?.id === hit.id, me2 = m.player2?.id === hit.id;
      if (!me1 && !me2) continue;
      const t = Date.parse(m.startDate);
      if (t >= before || (best && best.t >= t)) continue;
      const s = m.setScores.sort((x, y) => x.number - y.number).map((x) => me1 ? [x.p1Score, x.p2Score] : [x.p2Score, x.p1Score]);
      best = { t, s, opp: me1 ? m.player2.lastName : m.player1.lastName };
    }
  }
  return best;
}
// Owner's rule (24 Oct): SWING = every set of his last match won or lost by 4+ points,
// and he both won and lost sets. Backtest (14 days Setka, 864 picks): those picks won
// 23/37 = 62% v 70% overall; Leans 12/23 = 52%.
export const isSwing = (s) => s.some(([a, b]) => a > b) && s.some(([a, b]) => a < b) && s.every(([a, b]) => Math.abs(a - b) >= 4);
// Owner's rule (26 Oct): a Strong pick who lost from 2-1 up in sets in the last 3 days
// is dropped. Backtest (14 days Setka): those Strong picks won 15/27 = 56% v 82%.
export async function recentChoke(name, nameKey, before = Date.now()) {
  const ln = name.split(",")[0].trim();
  const d = await get(`/Players/en/paged?filter=${encodeURIComponent(ln)}&count=30&page=1`);
  const hit = Object.values(d?.players || {}).flat().find((p) => nameKey(p.lastName + ", " + p.firstName) === nameKey(name));
  if (!hit) return null;
  const pd = await get(`/Players/en/${hit.id}`);
  const since = before - 3 * 86400e3;
  const tids = (pd?.tournamentStats || []).filter((t) => { const s = Date.parse(t.startDate); return s < before && s > since - 86400e3; }).map((t) => t.id);
  for (const tid of tids) {
    const a = await get(`/Matches/en?tournamentId=${tid}`);
    for (const m of Array.isArray(a) ? a : []) {
      if (m.statusId !== 3 || m.technicalResult || !m.setScores || m.setScores.length < 4) continue;
      const me1 = m.player1?.id === hit.id; if (!me1 && m.player2?.id !== hit.id) continue;
      const t = Date.parse(m.startDate); if (t < since || t >= before) continue;
      const s = m.setScores.sort((x, y) => x.number - y.number).map((x) => me1 ? [x.p1Score, x.p2Score] : [x.p2Score, x.p1Score]);
      const up = s.slice(0, 3).filter(([x, y]) => x > y).length === 2;
      const won = me1 ? +m.player1Score > +m.player2Score : +m.player2Score > +m.player1Score;
      if (up && !won) return { t, opp: me1 ? m.player2.lastName : m.player1.lastName, s };
    }
  }
  return null;
}
