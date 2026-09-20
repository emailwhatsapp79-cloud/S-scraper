// Cron target: pull the card and save it without shipping 400 games back.
import { cors } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, normalise } from "./_card.js";
import { refreshSlips } from "./_slips.js";
import { recordPicks, recordStoredPicks, settlePicks } from "./_screen.js";
import { settleGames } from "./_results.js";
import { trainFinder, settleFinderPreds } from "./_finder.js";
import { fetchTTCard, normalise as ttNormalise, storeTT, enrichSettleTT } from "./_tt.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const started = Date.now();
  const { events, errors } = await fetchCard();
  const games = [];
  for (const ev of events) {
    const g = normalise(ev);
    if (g) games.push(g);
  }
  let saved = 0, saveError = null;
  try { saved = await store(games); }
  catch (e) { saveError = String(e?.message || e); }

  let slips = null;
  try { slips = await refreshSlips(); }
  catch (e) { slips = { error: String(e?.message || e) }; }

  let picked = 0, settled = 0, gamesSettled = 0, pickError = null, finder = null;
  try {
    picked = await recordPicks(games);
    settled = await settlePicks(25);
    gamesSettled = (await settleGames(25)).settled;
    try { await settleFinderPreds(); } catch { /* keep going */ }
  } catch (e) { pickError = String(e?.message || e); }
  try { finder = await trainFinder(); }
  catch (e) { finder = { error: String(e?.message || e) }; }

  // Table tennis — its own pile, fully isolated. Never fails the football poll.
  let tt = null;
  try {
    const { events } = await fetchTTCard();
    const ttSaved = await storeTT(events.map(ttNormalise));
    const ttTouched = (await enrichSettleTT(40)).touched;
    tt = { saved: ttSaved, touched: ttTouched };
  } catch (e) { tt = { error: String(e?.message || e) }; }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !saveError,
    tookMs: Date.now() - started,
    read: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    saved,
    slips,
    picked,
    settled,
    gamesSettled,
    pickError,
    finder: finder && {
      silent: finder.silent,
      nGames: finder.nGames,
      holdout: finder.holdout || null,
      error: finder.error || null,
    },
    tt,
    saveError,
    feedErrors: errors.length ? errors : null,
  });
}
