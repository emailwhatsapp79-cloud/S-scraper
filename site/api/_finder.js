// Finder brain: club ratings → score matrix → 1X2 / DC / correct score.
// Memory is the settled pile. Every live forecast is stored and graded
// when the game ends, then the next fit sees those results. No retrain button.
import { sql, rowToGame } from "./_db.js";
import { seal, open } from "./_crypto.js";
import { ensure } from "./_vault.js";
import { isUpcoming } from "./_shape.js";
import { fitRatings, forecast, bestLine, wonSel, LINES } from "./_brain.js";

function wilson(wins, nn, z = 1.96) {
  if (!nn) return [0, 1];
  const p = wins / nn, z2 = z * z, den = 1 + z2 / nn;
  const centre = p + z2 / (2 * nn);
  const adj = z * Math.sqrt((p * (1 - p) + z2 / (4 * nn)) / nn);
  return [(centre - adj) / den, (centre + adj) / den];
}

async function ensurePreds() {
  await sql`CREATE TABLE IF NOT EXISTS finder_preds (
    game_id TEXT PRIMARY KEY,
    event_id TEXT,
    home TEXT, away TEXT, league TEXT,
    kickoff BIGINT,
    pred_1x2 TEXT,
    p_home DOUBLE PRECISION,
    p_draw DOUBLE PRECISION,
    p_away DOUBLE PRECISION,
    pred_cs TEXT,
    p_cs DOUBLE PRECISION,
    bet_sel TEXT,
    bet_label TEXT,
    bet_price DOUBLE PRECISION,
    bet_p DOUBLE PRECISION,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    r_hg INT, r_ag INT,
    won_1x2 BOOLEAN,
    won_cs BOOLEAN,
    won_bet BOOLEAN,
    settled_at TIMESTAMPTZ
  )`;
}

async function loadSettled() {
  const rows = await sql`
    SELECT game_id, event_id, home, away, league, kickoff,
           ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2,
           ht_home, ht_draw, ht_away, cs_json,
           r_hg, r_ag
    FROM games WHERE r_status IS NOT NULL
      AND r_hg IS NOT NULL AND r_ag IS NOT NULL
    ORDER BY kickoff ASC
    LIMIT 8000`;
  return rows.map(fromRow);
}

function fromRow(r) {
  let cs = null;
  if (r.cs_json) {
    try { cs = JSON.parse(r.cs_json); } catch { cs = null; }
  }
  return {
    id: r.game_id,
    eventId: r.event_id || null,
    home: r.home, away: r.away,
    league: r.league || "",
    kickoff: r.kickoff ? Number(r.kickoff) : null,
    ft: { home: r.ft_home, draw: r.ft_draw, away: r.ft_away },
    dc: r.dc_1x == null ? null : { home_draw: r.dc_1x, home_away: r.dc_12, draw_away: r.dc_x2 },
    ht: r.ht_home == null ? null : { home: r.ht_home, draw: r.ht_draw, away: r.ht_away },
    cs,
    res: { hg: r.r_hg, ag: r.r_ag },
  };
}

function evalBets(ratings, games, floor, margin) {
  let nn = 0, wins = 0, implied = 0, ret = 0;
  let csN = 0, csW = 0, wxN = 0, wxW = 0;
  for (const g of games) {
    const f = forecast(ratings, g);
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    wxN++;
    if (wonSel(f.pred1x2, hg, ag)) wxW++;
    csN++;
    if (wonSel(f.topCs, hg, ag)) csW++;
    const bet = bestLine(f, g, floor, margin);
    if (!bet) continue;
    nn++;
    if (wonSel(bet.selection, hg, ag)) { wins++; ret += bet.price; }
    if (bet.price > 1) implied += 1 / bet.price;
  }
  const be = nn ? implied / nn : 0;
  const [lo, hi] = wilson(wins, nn);
  return {
    n: nn, wins, hit: nn ? wins / nn : 0, be, lo, hi,
    roi: nn ? (ret - nn) / nn : 0,
    wx: { n: wxN, wins: wxW, hit: wxN ? wxW / wxN : 0 },
    cs: { n: csN, wins: csW, hit: csN ? csW / csN : 0 },
  };
}

function tune(ratings, games) {
  const floors = [0.12, 0.2, 0.35, 0.45, 0.55, 0.65];
  const margins = [0.02, 0.04, 0.06, 0.08];
  let best = null;
  for (const f of floors) {
    for (const mg of margins) {
      const s = evalBets(ratings, games, f, mg);
      if (s.n < 25) continue;
      if (!(s.lo > s.be)) continue;
      const gap = s.lo - s.be;
      if (!best || gap > best.gap) best = { floor: f, margin: mg, gap, stats: s };
    }
  }
  return best || { floor: null, margin: null, gap: -1, stats: null };
}

async function putModel(data) {
  await ensure();
  const packed = seal(data);
  await sql`
    INSERT INTO vault (k, v, updated) VALUES ('finder', ${packed}, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()`;
}

export async function loadModel() {
  await ensure();
  const rows = await sql`SELECT v, updated FROM vault WHERE k = 'finder'`;
  if (!rows[0]) return null;
  try {
    const data = open(rows[0].v);
    data.updated = rows[0].updated;
    return data;
  } catch {
    return null;
  }
}

export async function settleFinderPreds() {
  await ensurePreds();
  const due = await sql`
    SELECT p.game_id, g.r_hg, g.r_ag
    FROM finder_preds p
    JOIN games g ON g.game_id = p.game_id
    WHERE p.settled_at IS NULL AND g.r_hg IS NOT NULL AND g.r_ag IS NOT NULL
    LIMIT 200`;
  let n = 0;
  for (const r of due) {
    const rows = await sql`SELECT * FROM finder_preds WHERE game_id = ${r.game_id}`;
    const p = rows[0];
    if (!p) continue;
    const hg = r.r_hg, ag = r.r_ag;
    await sql`
      UPDATE finder_preds SET
        r_hg = ${hg}, r_ag = ${ag},
        won_1x2 = ${wonSel(p.pred_1x2, hg, ag)},
        won_cs = ${wonSel(p.pred_cs, hg, ag)},
        won_bet = ${p.bet_sel ? wonSel(p.bet_sel, hg, ag) : null},
        settled_at = now()
      WHERE game_id = ${r.game_id}`;
    n++;
  }
  return n;
}

async function formCard() {
  const rows = await sql`
    SELECT won_1x2, won_cs, won_bet
    FROM finder_preds WHERE settled_at IS NOT NULL
    ORDER BY settled_at DESC LIMIT 40`;
  const tally = (key) => {
    const list = rows.filter((r) => r[key] != null);
    const wins = list.filter((r) => r[key] === true).length;
    return { n: list.length, wins, hit: list.length ? wins / list.length : 0 };
  };
  return { wx: tally("won_1x2"), cs: tally("won_cs"), bet: tally("won_bet") };
}

export async function trainFinder() {
  await ensurePreds();
  try { await sql`ALTER TABLE games ADD COLUMN IF NOT EXISTS cs_json TEXT`; } catch { /* ok */ }
  try { await settleFinderPreds(); } catch { /* still fit */ }
  const games = await loadSettled();
  if (games.length < 80) {
    const out = {
      ok: false, silent: true,
      reason: "Need about 80 settled games. " + games.length + " so far.",
      nGames: games.length, trainedAt: Date.now(),
    };
    await putModel(out);
    return out;
  }

  const cutTest = Math.floor(games.length * 0.7);
  const cutVal = Math.floor(cutTest * 0.8);
  const fitGames = games.slice(0, cutVal);
  const valGames = games.slice(cutVal, cutTest);
  const testGames = games.slice(cutTest);

  const fitR = fitRatings(fitGames);
  const chosen = tune(fitR, valGames);
  const pct = (x) => (x * 100).toFixed(1) + "%";

  const prod = fitRatings(games.slice(0, cutTest));
  const clubs = Object.values(prod).reduce((n, lg) => n + Object.keys(lg.clubs || {}).length, 0);
  const readout = "Ratings on " + clubs + " virtual clubs across " + Object.keys(prod).length + " leagues.";

  if (chosen.floor == null) {
    const holdout = evalBets(prod, testGames, 0.45, 0.04);
    const out = {
      ok: true, silent: true, proven: false,
      reason: "No priced line beat the book on validation. Forecasts still run; nothing is backed.",
      nGames: games.length, nFit: fitGames.length, nVal: valGames.length, nTest: testGames.length,
      floor: null, margin: null, holdout, form: await formCard(),
      keys: [], readout, trainedAt: Date.now(), ratings: prod,
    };
    await putModel(out);
    return out;
  }

  const holdout = evalBets(prod, testGames, chosen.floor, chosen.margin);
  const proven = holdout.n >= 25 && holdout.lo > holdout.be;
  const silent = !proven;
  const out = {
    ok: true, silent, proven,
    reason: silent
      ? "A priced line looked real in training but did not hold (" + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + "). Forecasts stay; bets stay off."
      : "Proven: " + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + ", floor " + pct(holdout.lo) + ". ROI " + (holdout.roi >= 0 ? "+" : "") + pct(holdout.roi) + ".",
    nGames: games.length, nFit: fitGames.length, nVal: valGames.length, nTest: testGames.length,
    floor: chosen.floor, margin: chosen.margin, holdout,
    form: await formCard(),
    keys: [], readout, trainedAt: Date.now(), ratings: prod,
  };
  await putModel(out);
  return out;
}

export async function ensureModel() {
  const cur = await loadModel();
  const age = cur?.trainedAt ? Date.now() - Number(cur.trainedAt) : Infinity;
  if (cur && cur.ratings && age < 30 * 60 * 1000) return cur;
  return trainFinder();
}

function linesOf(f, g) {
  const out = [];
  for (const line of LINES) {
    const price = Number(line.priceOf(g));
    out.push({
      selection: line.sel,
      label: line.label,
      p: line.pOf(f),
      price: isFinite(price) && price > 1 ? price : null,
    });
  }
  return out;
}

async function remember(g, f, bet) {
  await ensurePreds();
  await sql`
    INSERT INTO finder_preds (
      game_id, event_id, home, away, league, kickoff,
      pred_1x2, p_home, p_draw, p_away, pred_cs, p_cs,
      bet_sel, bet_label, bet_price, bet_p
    ) VALUES (
      ${g.id}, ${g.eventId || null}, ${g.home}, ${g.away}, ${g.league || ""}, ${g.kickoff || null},
      ${f.pred1x2}, ${f.p1}, ${f.pX}, ${f.p2}, ${f.topCs}, ${f.pCs},
      ${bet?.selection || null}, ${bet?.label || null}, ${bet?.price || null}, ${bet?.p || null}
    )
    ON CONFLICT (game_id) DO UPDATE SET
      pred_1x2 = EXCLUDED.pred_1x2,
      p_home = EXCLUDED.p_home, p_draw = EXCLUDED.p_draw, p_away = EXCLUDED.p_away,
      pred_cs = EXCLUDED.pred_cs, p_cs = EXCLUDED.p_cs,
      bet_sel = EXCLUDED.bet_sel, bet_label = EXCLUDED.bet_label,
      bet_price = EXCLUDED.bet_price, bet_p = EXCLUDED.bet_p
    WHERE finder_preds.settled_at IS NULL`;
}

export async function livePicks(pack, liveGames) {
  if (!pack || !pack.ratings) return [];
  const live = Array.isArray(liveGames) ? liveGames.filter((g) => g && g.id) : [];
  let src = live.filter((g) => g.upcoming);
  if (!src.length) {
    const cutoff = Date.now() - 2 * 60 * 1000;
    const rows = await sql`
      SELECT * FROM games
      WHERE kickoff IS NULL OR kickoff > ${cutoff}
      ORDER BY kickoff ASC NULLS LAST
      LIMIT 400`;
    src = rows.map(rowToGame).filter((g) => g.upcoming || isUpcoming(g.status, g.kickoff));
  }
  const csById = {};
  for (const g of live) if (g.cs) csById[g.id] = g.cs;

  const out = [];
  const jobs = [];
  for (const raw of src) {
    const g = { ...raw, cs: csById[raw.id] || raw.cs || null };
    const f = forecast(pack.ratings, g);
    const bet = pack.silent ? null : bestLine(f, g, pack.floor ?? 0.45, pack.margin ?? 0.04);
    jobs.push(remember(g, f, bet).catch(function () {}));
    out.push({
      id: g.id, eventId: g.eventId,
      home: g.home, away: g.away, league: g.league, kickoff: g.kickoff,
      ft: g.ft, dc: g.dc, ht: g.ht, cs: g.cs,
      pred1x2: f.pred1x2,
      p1: f.p1, pX: f.pX, p2: f.p2, p1X: f.p1X, pX2: f.pX2,
      topCs: f.topCs, pCs: f.pCs,
      nH: f.nH, nA: f.nA,
      csTop: (f.cs || []).filter((c) => c.selection !== "Other").slice(0, 6),
      lines: linesOf(f, g),
      bet,
    });
  }
  if (jobs.length) await Promise.all(jobs);
  out.sort((a, b) => (Number(a.kickoff) || Infinity) - (Number(b.kickoff) || Infinity));
  return out;
}
