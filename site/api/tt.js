// Table-tennis reader. Reads SportyBet's upcoming TT card, banks it, fills a
// bounded batch of odds/results, and returns the upcoming list. Gated like the
// rest of the app. Nothing here shares state with the football endpoints.
import { guard } from "./_gate.js";
import { fetchTTCard, normalise, storeTT, enrichSettleTT, listUpcomingTT, listRecentResultsTT, countsTT, getModelMeta } from "./_tt.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  const ph = {};
  const mark = (k, t0) => { ph[k] = Date.now() - t0; };
  let saved = 0, saveError = null, feedErrors = null, enriched = 0;

  let t = Date.now();
  try {
    const { events, errors } = await fetchTTCard();
    feedErrors = errors && errors.length ? errors : null;
    const games = events.map(normalise);
    try { saved = await storeTT(games); }
    catch (e) { saveError = String(e?.message || e); }
  } catch (e) {
    feedErrors = [String(e?.message || e)];
  }
  mark("card", t);

  t = Date.now();
  try { enriched = (await enrichSettleTT(25)).touched; } catch { /* still serve */ }
  mark("enrich", t);

  let games = [], results = [], counts = { total: 0, settled: 0 }, model = null;
  t = Date.now();
  try { games = await listUpcomingTT(400); } catch (e) { saveError = saveError || String(e?.message || e); }
  mark("upcoming", t);
  t = Date.now();
  try { results = await listRecentResultsTT(60); } catch { /* ignore */ }
  mark("results", t);
  t = Date.now();
  try { counts = await countsTT(); } catch { /* ignore */ }
  mark("counts", t);
  t = Date.now();
  try { model = await getModelMeta(); } catch { /* ignore */ }
  mark("model", t);

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: true,
    tookMs: Date.now() - started,
    phases: ph,
    saved, enriched, saveError, feedErrors,
    stored: counts.total,
    settled: counts.settled,
    count: games.length,
    games,
    results,
    model,
  });
}
