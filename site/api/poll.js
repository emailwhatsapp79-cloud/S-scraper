// Cron target: pull the card and save it without shipping 400 games back.
import { cors, sql } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, normalise } from "./_card.js";
import { refreshSlips } from "./_slips.js";
import { recordPicks, recordStoredPicks, settlePicks } from "./_screen.js";
import { settleGames } from "./_results.js";
import { fetchTTCard, normalise as ttNormalise, storeTT, enrichSettleTT, rebuildPack } from "./_tt.js";
import { pullScores24 } from "./_s24.js";
import { pullSetka } from "./_setka.js";
// Sofascore history is disabled: its API 403s every server request, so it banked
// nothing and only wasted poll time. scores24 + the official Setka feed cover it.

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

  let picked = 0, settled = 0, gamesSettled = 0, pickError = null;
  try {
    picked = await recordPicks(games);
    settled = await settlePicks(25);
    gamesSettled = (await settleGames(25)).settled;
  } catch (e) { pickError = String(e?.message || e); }
  try {
    await sql`DROP TABLE IF EXISTS finder_preds`;
    await sql`DELETE FROM vault WHERE k = 'finder'`;
  } catch { /* leftover Finder rows */ }

  let tt = null;
  try {
    const { events } = await fetchTTCard();
    const games = events.map(ttNormalise);
    const ttSaved = await storeTT(games);
    const ttTouched = (await enrichSettleTT(80)).touched;
    const names = events.flatMap((ev) => [ev.homeTeamName, ev.awayTeamName].filter(Boolean));
    const setkaNames = games.filter((g) => /setka/i.test(g.tourn || ""))
      .flatMap((g) => [g.home, g.away]).filter(Boolean);
    let s24 = null, setka = null;
    try { s24 = await pullScores24(names, { skipHtml: false, more: true, pages: 5, first: 50, days: 400, players: 0, deadlineMs: 18000 }); }
    catch (e) { s24 = { error: String(e?.message || e) }; }
    try { setka = await pullSetka(setkaNames, { players: 12, tournaments: 8, deadlineMs: 12000 }); }
    catch (e) { setka = { error: String(e?.message || e) }; }
    let pack = null;
    try { pack = await rebuildPack(); pack = { built: pack?.builtAt || null, nGames: pack?.nGames || 0 }; }
    catch (e) { pack = { error: String(e?.message || e) }; }
    tt = { saved: ttSaved, touched: ttTouched, s24, setka, pack };
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
    tt,
    saveError,
    feedErrors: errors.length ? errors : null,
  });
}
