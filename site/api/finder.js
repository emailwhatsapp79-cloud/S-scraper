import { guard } from "./_gate.js";
import { settleGames } from "./_results.js";
import { fetchCard, normalise } from "./_card.js";
import { store } from "./_store.js";
import { ensureModel, livePicks, settleFinderPreds } from "./_finder.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  try {
    const cardP = fetchCard().then(({ events }) => {
      const games = [];
      for (const ev of events) {
        const g = normalise(ev);
        if (g) games.push(g);
      }
      return games;
    });
    try { await settleGames(40); } catch { /* still serve */ }
    try { await settleFinderPreds(); } catch { /* still serve */ }
    const packP = ensureModel();
    let live = [];
    try { live = await cardP; store(live).catch(function () {}); }
    catch { live = []; }
    const pack = await packP;
    const picks = await livePicks(pack, live);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      tookMs: Date.now() - started,
      silent: !!pack.silent,
      proven: !!pack.proven,
      reason: pack.reason || "",
      readout: pack.readout || "",
      nGames: pack.nGames || 0,
      nTest: pack.nTest || 0,
      floor: pack.floor || null,
      margin: pack.margin || null,
      trainedAt: pack.trainedAt || null,
      holdout: pack.holdout || null,
      form: pack.form || null,
      picks,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
