// Cron target: pull the card and save it without shipping 400 games back.
import { sql, logErr } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, fetchLive, normalise } from "./_card.js";
import { refreshSlips } from "./_slips.js";
import { recordPicks, settlePicks } from "./_screen.js";
import { settleGames, settleFromEvents, countsVF } from "./_results.js";
import { fetchTTCard, normalise as ttNormalise, storeTT, enrichSettleTT, rebuildPack, settleTTResults } from "./_tt.js";
import { pullScores24 } from "./_s24.js";
import { pullSetka, pullSetkaDays } from "./_setka.js";
import { rebuildVF } from "./_vf_model.js";
import { refreshEB } from "./_eb.js";
import { requireFill } from "./_gate.js";
import { touchHealth } from "./_health.js";
// Sofascore history is disabled: its API 403s every server request, so it banked
// nothing and only wasted poll time. scores24 + the official Setka feed cover it.

async function vfHeartbeat() {
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
    } catch (e) { logErr("vf.live", e); }
  }
  if (Date.now() < budget - 4000) {
    try { settled = await settleGames(60); }
    catch (e) { logErr("vf.settle", e); settled = { error: String(e?.message || e) }; }
  }
  let pack = null;
  if (Date.now() < budget - 2000) {
    try {
      const p = await rebuildVF();
      pack = { nGames: p.nGames, edge: p.edge, holdout: p.holdout, builtAt: p.builtAt };
    } catch (e) { logErr("vf.pack", e); pack = { error: String(e?.message || e) }; }
  }
  let counts = { total: 0, settled: 0 };
  try { counts = await countsVF(); } catch (e) { logErr("vf.counts", e); }
  const out = {
    ok: !cardErr, tookMs: Date.now() - started,
    saved, liveN, liveEnded, settled, pack,
    stored: counts.total, banked: counts.settled, cardErr,
  };
  await touchHealth("vf", { saved, liveN, liveEnded, settled: settled && settled.settled, stored: counts.total, banked: counts.settled });
  return out;
}

// eBasketball banking takes no key, by the owner's choice: it only reads
// SportyBet's public card and saves it, so the GitHub schedule can call it
// without a stored secret. A run inside the last 4 minutes answers "skipped",
// so calling it more often does nothing.
async function ebTick(res) {
  let out;
  try {
    const last = await sql`SELECT at FROM health WHERE k = 'eb'`;
    const at = last[0] ? new Date(last[0].at).getTime() : 0;
    if (Date.now() - at < 4 * 60 * 1000) {
      out = { ok: true, skipped: true };
    } else {
      await touchHealth("eb", { started: true });
      out = { ok: true, ...(await refreshEB()) };
      // Table tennis results ride the same 10-minute timer: public results
      // only, written onto games already on file.
      try {
        out.tt = await settleTTResults(3, 8);
        // Train what just settled, so each game's pre-result % is written
        // while the record is fresh (short deadline: this route has 30s).
        const { trainBatch } = await import("./_ratings.js");
        out.tt.trained = (await trainBatch(1500, 7000)).trained;
      } catch (e) { out.tt = { ...(out.tt || {}), error: String(e?.message || e) }; }
      await touchHealth("eb", out);
    }
  } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(out);
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.get("eb") === "1") return ebTick(res);

  if (requireFill(req, res)) return;

  if (url.searchParams.get("vf") === "1") {
    const out = await vfHeartbeat();
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json(out);
  }

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
  } catch (e) { logErr("poll.picks", e); pickError = String(e?.message || e); }

  let eb = null;
  try { eb = await refreshEB(); }
  catch (e) { logErr("poll.eb", e); eb = { error: String(e?.message || e) }; }

  let tt = null;
  try {
    const { events } = await fetchTTCard();
    const games = events.map(ttNormalise);
    const ttSaved = await storeTT(games);
    const ttTouched = (await enrichSettleTT(80)).touched;
    try { await settleTTResults(30, 20); } catch (e) { logErr("poll.ttresults", e); }
    const names = events.flatMap((ev) => [ev.homeTeamName, ev.awayTeamName].filter(Boolean));
    const setkaNames = games.filter((g) => /setka/i.test(g.tourn || ""))
      .flatMap((g) => [g.home, g.away]).filter(Boolean);
    let s24 = null, setka = null, setkaSweep = null;
    try { s24 = await pullScores24(names, { skipHtml: true, latestOnly: true, pages: 2, first: 40, days: 14, players: 0 }); }
    catch (e) { s24 = { error: String(e?.message || e) }; }
    // Broad Setka firehose. Payload is ~13s/day, so sweep the most recent day
    // or two each run; older days are marked done and never re-fetched.
    try { setkaSweep = await pullSetkaDays({ days: 1, deadlineMs: 16000 }); }
    catch (e) { setkaSweep = { error: String(e?.message || e) }; }
    try { setka = await pullSetka(setkaNames, { players: 8, tournaments: 8, deadlineMs: 8000 }); }
    catch (e) { setka = { error: String(e?.message || e) }; }
    let trained = null;
    try { trained = await rebuildPack(); }
    catch (e) { trained = { error: String(e?.message || e) }; }
    tt = { saved: ttSaved, touched: ttTouched, s24, setka, setkaSweep, trained };
  } catch (e) { logErr("poll.tt", e); tt = { error: String(e?.message || e) }; }

  await touchHealth("poll", {
    saved, picked, settled, gamesSettled,
    tt: tt && !tt.error, tookMs: Date.now() - started,
  });
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
    eb,
    saveError,
    feedErrors: errors.length ? errors : null,
  });
}
