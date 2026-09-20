// Table-tennis reader. Reads SportyBet's upcoming TT card, banks it, fills a
// bounded batch of odds/results, and returns the upcoming list. Gated like the
// rest of the app. Nothing here shares state with the football endpoints.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, enrichSettleTT, listUpcomingTT, listRecentResultsTT, countsTT } from "./_tt.js";
import { pullSofaHistory } from "./_sofa.js";
import { pullScores24 } from "./_s24.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  let saved = 0, saveError = null, feedErrors = null, enriched = 0, cardNames = [];

  try {
    const { events, errors } = await fetchTTCard();
    feedErrors = errors && errors.length ? errors : null;
    const games = events.map(normalise);
    cardNames = games.flatMap((g) => [g.home, g.away]);
    try { saved = await storeTT(games); }
    catch (e) { saveError = String(e?.message || e); }
  } catch (e) {
    feedErrors = [String(e?.message || e)];
  }

  try { enriched = (await enrichSettleTT(40)).touched; } catch { /* still serve */ }

  let s24 = null, sofa = null;
  try { s24 = await pullScores24(cardNames, { pages: 1, first: 50, days: 7 }); }
  catch (e) { s24 = { error: String(e?.message || e) }; }
  try { sofa = await pullSofaHistory(cardNames, { players: 2, pages: 3 }); }
  catch (e) { sofa = { error: String(e?.message || e) }; }

  let games = [], results = [], counts = { total: 0, settled: 0 };
  try { games = await listUpcomingTT(400); } catch (e) { saveError = saveError || String(e?.message || e); }
  try { results = await listRecentResultsTT(60); } catch { /* ignore */ }
  try { counts = await countsTT(); } catch { /* ignore */ }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    saved, enriched, saveError, feedErrors,
    sofa, s24,
    stored: counts.total,
    settled: counts.settled,
    count: games.length,
    games,
    results,
  });
}
