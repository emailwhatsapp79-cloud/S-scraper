import { guard } from "./_gate.js";
import { sql, rowToGame } from "./_db.js";
import { getVFPack, forecastVF, rebuildVF } from "./_vf_model.js";
import { isUpcoming, dropClashes } from "./_shape.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  const url = new URL(req.url, "http://x");
  let pack;
  try {
    pack = url.searchParams.get("rebuild") === "1" ? await rebuildVF() : await getVFPack();
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: false, error: String(e?.message || e) });
  }

  let picks = [];
  if (pack && pack.edge) {
    try {
      const cutoff = Date.now() - 2 * 60 * 1000;
      const rows = await sql`
        SELECT * FROM games
        WHERE kickoff > ${cutoff}
        ORDER BY kickoff ASC NULLS LAST LIMIT 400`;
      const games = dropClashes(rows.map(rowToGame).filter((g) => g.upcoming));
      for (const g of games) {
        const f = forecastVF(pack, g);
        if (f && f.take) {
          picks.push({
            id: g.id, eventId: g.eventId, home: g.home, away: g.away,
            league: g.league, kickoff: g.kickoff,
            selection: f.side === "H" ? "1X" : "X2",
            label: f.label, price: f.price,
            pDC: Math.round(f.pDC * 100),
            nH: f.nH, nA: f.nA,
          });
        }
      }
    } catch { picks = []; }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    nGames: pack.nGames || 0,
    edge: !!pack.edge,
    holdout: pack.holdout || null,
    builtAt: pack.builtAt || null,
    picks,
  });
}
