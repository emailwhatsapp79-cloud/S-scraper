// Strategy Lab data: settled games (odds + result) for client-side backtest
// and breakdowns. Settles a batch first so the set stays fresh.
import { cors, logErr } from "./_db.js";
import { guard } from "./_gate.js";
import { settleGames, settledGames } from "./_results.js";
import { getVFPack } from "./_vf_model.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  try {
    let justSettled = 0;
    try { justSettled = (await settleGames(45)).settled; } catch (e) { logErr("analytics.settle", e); }
    const games = await settledGames(8000);
    let pattern = null;
    try {
      const p = await getVFPack();
      pattern = { nGames: p.nGames, edge: p.edge, holdout: p.holdout, builtAt: p.builtAt };
    } catch (e) { logErr("analytics.pattern", e); pattern = null; }
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, tookMs: Date.now() - started, justSettled, count: games.length, games, pattern });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
