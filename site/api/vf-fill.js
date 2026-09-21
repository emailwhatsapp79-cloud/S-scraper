// Heartbeat: bank every vFootball game on the card and settle anything that
// just finished. Cron hits this with the tab closed. No SportyBet login.
import { cors } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, fetchLive, normalise } from "./_card.js";
import { settleGames, settleFromEvents, countsVF } from "./_results.js";
import { rebuildVF } from "./_vf_model.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const started = Date.now();
  const budget = started + 26000;

  let saved = 0, liveN = 0, liveEnded = 0, settled = null, cardErr = null;
  try {
    const { events, errors } = await fetchCard();
    const games = [];
    for (const ev of events) {
      const g = normalise(ev);
      if (g) games.push(g);
    }
    if (games.length) saved = await store(games);
    if (errors && errors.length) cardErr = errors.join("; ");
  } catch (e) {
    cardErr = String(e?.message || e);
  }

  if (Date.now() < budget - 8000) {
    try {
      const live = await fetchLive();
      liveN = live.length;
      liveEnded = await settleFromEvents(live);
      const extra = [];
      for (const ev of live) {
        const g = normalise(ev);
        if (g) extra.push(g);
      }
      if (extra.length) await store(extra);
    } catch { /* keep settling */ }
  }

  if (Date.now() < budget - 4000) {
    try { settled = await settleGames(60); }
    catch (e) { settled = { error: String(e?.message || e) }; }
  }

  let pack = null;
  if (Date.now() < budget - 2000) {
    try {
      const p = await rebuildVF();
      pack = { nGames: p.nGames, edge: p.edge, holdout: p.holdout, builtAt: p.builtAt };
    } catch (e) { pack = { error: String(e?.message || e) }; }
  }

  let counts = { total: 0, settled: 0 };
  try { counts = await countsVF(); } catch { /* ignore */ }

  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: !cardErr,
    tookMs: Date.now() - started,
    saved, liveN, liveEnded, settled, pack,
    stored: counts.total, banked: counts.settled,
    cardErr,
  });
}
