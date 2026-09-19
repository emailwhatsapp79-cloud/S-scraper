// Strategy Lab data: settled games (odds + result) for client-side backtest
// and breakdowns. Settles a batch first so the set stays fresh.
import { cors } from "./_db.js";
import { guard } from "./_gate.js";
import { settleGames, settledGames } from "./_results.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  try {
    let justSettled = 0;
    try { justSettled = (await settleGames(45)).settled; } catch { /* keep serving */ }
    const games = await settledGames(4000);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, tookMs: Date.now() - started, justSettled, count: games.length, games });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
