// Finder brain: club ratings → score matrix → 1X2 / DC / correct score.
// Memory is the settled pile. Every live forecast is stored and graded
// when the game ends, then the next fit sees those results. No retrain button.
import { sql, rowToGame } from "./_db.js";
import { seal, open } from "./_crypto.js";
import { ensure } from "./_vault.js";
import { isUpcoming } from "./_shape.js";
import { fitRatings, fitPairs, forecast, bestEdge, wonSel, LINES } from "./_brain.js";

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

function extraOf(pack) {
  return {
    pairs: pack.pairs || { pair: {}, home: {} },
    wPair: pack.wPair || 0,
    wHt: pack.wHt || 0,
    wClub: pack.wClub || 0,
  };
}

function evalBets(ratings, pairs, w, games, edgeMin) {
  const extra = { pairs, wPair: w.wPair, wHt: w.wHt, wClub: w.wClub };
  let nn = 0, wins = 0, implied = 0, ret = 0;
  let csN = 0, csW = 0, wxN = 0, wxW = 0;
  for (const g of games) {
    const f = forecast(ratings, g, extra);
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    wxN++;
    if (wonSel(f.pred1x2, hg, ag)) wxW++;
    csN++;
    if (wonSel(f.topCs, hg, ag)) csW++;
    const bet = bestEdge(f, g, edgeMin);
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

function tune(ratings, pairs, games) {
  const wPairs = [0, 0.5, 1];
  const wHts = [0, 0.4, 0.8];
  const wClubs = [0, 0.4, 0.8];
  const edges = [0.04, 0.06, 0.08, 0.12];
  let best = null;
  for (const wPair of wPairs) {
    for (const wHt of wHts) {
      for (const wClub of wClubs) {
        for (const edgeMin of edges) {
          const w = { wPair, wHt, wClub };
          const s = evalBets(ratings, pairs, w, games, edgeMin);
          if (s.n < 20) continue;
          if (!(s.lo > s.be)) continue;
          const gap = s.lo - s.be;
          if (!best || gap > best.gap) best = { w, edgeMin, gap, stats: s };
        }
      }
    }
  }
  return best || { w: { wPair: 0, wHt: 0, wClub: 0 }, edgeMin: null, gap: -1, stats: null };
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
  const fitP = fitPairs(fitGames);
  const chosen = tune(fitR, fitP, valGames);
  const pct = (x) => (x * 100).toFixed(1) + "%";

  const prod = fitRatings(games.slice(0, cutTest));
  const prodP = fitPairs(games.slice(0, cutTest));
  const liveR = fitRatings(games);
  const liveP = fitPairs(games);
  const w = chosen.w || { wPair: 0, wHt: 0, wClub: 0 };

  if (chosen.edgeMin == null) {
    const holdout = evalBets(prod, prodP, w, testGames, 0.06);
    const out = {
      ok: true, silent: true, proven: false,
      reason: "No priced line beat the book on validation.",
      nGames: games.length, nFit: fitGames.length, nVal: valGames.length, nTest: testGames.length,
      wPair: w.wPair, wHt: w.wHt, wClub: w.wClub, edgeMin: 0.06,
      holdout, form: await formCard(),
      trainedAt: Date.now(), ratings: liveR, pairs: liveP,
    };
    await putModel(out);
    return out;
  }

  const holdout = evalBets(prod, prodP, w, testGames, chosen.edgeMin);
  const proven = holdout.n >= 20 && holdout.lo > holdout.be;
  const silent = !proven;
  const out = {
    ok: true, silent, proven,
    reason: silent
      ? "Edge did not hold (" + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + ")."
      : "Proven: " + pct(holdout.hit) + " vs " + pct(holdout.be) + ", ROI " + (holdout.roi >= 0 ? "+" : "") + pct(holdout.roi) + ".",
    nGames: games.length, nFit: fitGames.length, nVal: valGames.length, nTest: testGames.length,
    wPair: w.wPair, wHt: w.wHt, wClub: w.wClub, edgeMin: chosen.edgeMin,
    holdout, form: await formCard(),
    trainedAt: Date.now(), ratings: liveR, pairs: liveP,
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
  const extra = extraOf(pack);
  const edgeMin = pack.edgeMin == null ? 0.06 : Number(pack.edgeMin);
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
    const f = forecast(pack.ratings, g, extra);
    const bet = bestEdge(f, g, edgeMin);
    jobs.push(remember(g, f, bet).catch(function () {}));
    if (!bet) continue;
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
  out.sort((a, b) => (Number(b.bet?.edge) || 0) - (Number(a.bet?.edge) || 0));
  return out;
}
