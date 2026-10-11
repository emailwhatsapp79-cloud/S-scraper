// Cron target: pull the card and save it without shipping 400 games back.
import { sql, logErr } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, fetchLive, normalise } from "./_card.js";
import { refreshSlips } from "./_slips.js";
import { recordPicks, settlePicks } from "./_screen.js";
import { settleGames, settleFromEvents, countsVF } from "./_results.js";
import { fetchTTCard, normalise as ttNormalise, storeTT, enrichSettleTT, rebuildPack, settleTTResults } from "./_tt.js";
import { pullScores24, ingestS24Pages } from "./_s24.js";
import { githubOk } from "./_oidc.js";
import { rowsFromPage, saveTnRows, pullTnResults } from "./_tn_hist.js";
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

// The public timer route (GitHub calls it; it takes no key by the owner's
// choice and only reads public SportyBet data). Each call refreshes open
// slips. While a booked game is on, or about to start, GitHub calls every 30
// seconds so the phone hears "started", "winning" and "losing" quickly. Other
// times it calls once a minute. Calls closer than 20s apart answer "skipped"
// and still say whether a game is hot, so the fast loop does not drop back.
// The heavier eBasketball and table tennis banking runs at most every 9 minutes.
async function ebTick(res) {
  let out = { ok: true };
  try {
    const rows = await sql`SELECT k, v, at FROM health WHERE k IN ('watch', 'eb')`;
    const at = Object.fromEntries(rows.map((r) => [r.k, new Date(r.at).getTime()]));
    const now = Date.now();
    if (now - (at.watch || 0) < 20 * 1000) {
      out.skipped = true;
      try {
        const row = rows.find((r) => r.k === "watch");
        out.hot = !!(row && JSON.parse(row.v || "{}").hot);
      } catch { out.hot = false; }
    } else {
      await touchHealth("watch", { started: true });
      try { out.slips = await refreshSlips(); } catch (e) { out.slips = { error: String(e?.message || e) }; }
      // Owner-authorized: every minute, each open slip's SportyBet cash-out
      // state and amount (shown in the app; used by the auto cash-out).
      try {
        const { readOpenBets } = await import("./_sb_bets.js");
        out.bets = await readOpenBets();
      } catch (e) { out.bets = { error: String(e?.message || e).slice(0, 120) }; }
      if (now - (at.eb || 0) >= 9 * 60 * 1000) {
        await touchHealth("eb", { started: true });
        Object.assign(out, await refreshEB());
        // Keep the table tennis card current with the app closed: games
        // SportyBet adds an hour before play are banked and get their stats
        // the moment the card is next read.
        try {
          const { events } = await fetchTTCard();
          out.ttCard = await storeTT(events.map(ttNormalise));
        } catch (e) { out.ttCard = String(e?.message || e).slice(0, 80); }
        try {
          out.tt = await settleTTResults(3, 8);
          const { trainBatch } = await import("./_ratings.js");
          out.tt.trained = (await trainBatch(1500, 7000)).trained;
        } catch (e) { out.tt = { ...(out.tt || {}), error: String(e?.message || e) }; }
        try {
          out.tn = await pullTnResults(3, 10);
          const { trainTennis } = await import("./_tn_model.js");
          Object.assign(out.tn, await trainTennis(2000, 6000));
        } catch (e) { out.tn = { ...(out.tn || {}), error: String(e?.message || e).slice(0, 120) }; }
        // Full-league history (TT Elite Series, Czech Liga Pro, ...) arrives from
        // the GitHub workflow at ?s24push=1: scores24 blocks Vercel's servers.
        await touchHealth("eb", out);
      }
      await touchHealth("watch", { hot: !!(out.slips && out.slips.hot), slips: out.slips });
      out.hot = !!(out.slips && out.slips.hot);
    }
  } catch (e) { out = { ok: false, error: String(e?.message || e) }; }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json(out);
}

// scores24 pages POSTed by our own GitHub workflow, proven by GitHub's signed
// token. Saved, then trained at once so the next card read uses them.
async function s24Push(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  let who = null;
  try { who = await githubOk(req); } catch (e) { logErr("s24push.auth", e); }
  if (!who) return res.status(401).json({ ok: false, error: "no" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const out = { ok: true };
  try { Object.assign(out, await ingestS24Pages(body && body.pages)); }
  catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) }); }
  try {
    const { trainBatch } = await import("./_ratings.js");
    out.trained = (await trainBatch(3000, 15000)).trained;
  } catch (e) { out.trainErr = String(e?.message || e).slice(0, 120); }
  try { await touchHealth("s24", out); } catch { /* health is best-effort */ }
  return res.status(200).json(out);
}

// A year of SportyBet tennis results, fetched by the tn-backfill workflow
// (raw eventResultList pages), proven by GitHub's signed token.
async function tnPush(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false });
  let who = null;
  try { who = await githubOk(req); } catch (e) { logErr("tnpush.auth", e); }
  if (!who) return res.status(401).json({ ok: false, error: "no" });
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const pages = Array.isArray(body && body.pages) ? body.pages.slice(0, 40) : [];
  try {
    const saved = await saveTnRows(pages.flatMap((d) => rowsFromPage(d)));
    return res.status(200).json({ ok: true, saved });
  } catch (e) { return res.status(500).json({ ok: false, error: String(e?.message || e).slice(0, 160) }); }
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://x");
  if (url.searchParams.get("eb") === "1") return ebTick(res);
  if (url.searchParams.get("s24push") === "1") return s24Push(req, res);
  if (url.searchParams.get("tnpush") === "1") return tnPush(req, res);

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
