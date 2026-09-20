// Learns its own picks from settled games. No hand-written bands, no
// morning/night labels. Memory is the games table; this re-reads the whole
// pile. One forest per market (a pooled forest compresses every probability
// toward 50% and can't tell a strong favourite from a coin-flip), then it backs
// the market it is most confident in when that confidence beats the price.
import { sql, rowToGame } from "./_db.js";
import { seal, open } from "./_crypto.js";
import { ensure } from "./_vault.js";
import { trainForest, predictOne, featureUse } from "./_forest.js";
import { isUpcoming } from "./_shape.js";

const NAMES = [
  "FT home", "FT draw", "FT away",
  "DC 1X", "DC 12", "DC X2",
  "HT home", "HT draw", "HT away",
  "HT split", "FT fav", "FT dog", "FT gap",
  "league", "hour", "weekday",
];

const MARKETS = [
  { id: 0, sel: "1",  label: "Home",          priceOf: (g) => g.ft?.home,      won: (h, a) => h > a },
  { id: 1, sel: "X",  label: "Draw",          priceOf: (g) => g.ft?.draw,      won: (h, a) => h === a },
  { id: 2, sel: "2",  label: "Away",          priceOf: (g) => g.ft?.away,      won: (h, a) => a > h },
  { id: 3, sel: "1X", label: "Home or Draw",  priceOf: (g) => g.dc?.home_draw, won: (h, a) => h >= a },
  { id: 4, sel: "X2", label: "Draw or Away",  priceOf: (g) => g.dc?.draw_away, won: (h, a) => a >= h },
  { id: 5, sel: "12", label: "Home or Away",  priceOf: (g) => g.dc?.home_away, won: (h, a) => h !== a },
];

const FOREST = { nTrees: 24, maxDepth: 6, minLeaf: 18, seed: 2026 };

function n(v) {
  const x = Number(v);
  return isFinite(x) ? x : null;
}

function leagueNum(s) {
  const t = String(s || "");
  let h = 0;
  for (let i = 0; i < t.length; i++) h = (h * 33 + t.charCodeAt(i)) >>> 0;
  return h % 97;
}

function hourOf(kickoff) {
  const k = Number(kickoff);
  if (!isFinite(k) || k <= 0) return null;
  return Math.floor((k % 86400000) / 3600000);
}

function weekdayOf(kickoff) {
  const k = Number(kickoff);
  if (!isFinite(k) || k <= 0) return null;
  return new Date(k).getUTCDay();
}

// One feature row per game (the market is a separate model, not a feature).
function vec(g) {
  const fh = n(g.ft?.home), fd = n(g.ft?.draw), fa = n(g.ft?.away);
  if (fh == null || fd == null || fa == null) return null;
  const fav = Math.min(fh, fa), dog = Math.max(fh, fa);
  const htH = n(g.ht?.home), htD = n(g.ht?.draw), htA = n(g.ht?.away);
  const htFav = fh <= fa ? htH : htA;
  const htDog = fh <= fa ? htA : htH;
  const split = htFav && htDog ? htDog / htFav : null;
  return [
    fh, fd, fa,
    n(g.dc?.home_draw), n(g.dc?.home_away), n(g.dc?.draw_away),
    htH, htD, htA,
    split, fav, dog, dog - fav,
    leagueNum(g.league), hourOf(g.kickoff), weekdayOf(g.kickoff),
  ].map((x) => (x == null || !isFinite(x) ? -1 : x));
}

function wilson(wins, nn, z = 1.96) {
  if (!nn) return [0, 1];
  const p = wins / nn, z2 = z * z, den = 1 + z2 / nn;
  const centre = p + z2 / (2 * nn);
  const adj = z * Math.sqrt((p * (1 - p) + z2 / (4 * nn)) / nn);
  return [(centre - adj) / den, (centre + adj) / den];
}

// One forest per market: is THIS market going to land, given the game's numbers.
function trainMarkets(games) {
  return MARKETS.map((m) => {
    const X = [], y = [];
    for (const g of games) {
      const hg = g.res?.hg, ag = g.res?.ag;
      if (hg == null || ag == null) continue;
      const price = n(m.priceOf(g));
      if (price == null || price <= 1) continue;
      const x = vec(g);
      if (!x) continue;
      X.push(x);
      y.push(m.won(hg, ag) ? 1 : 0);
    }
    if (X.length < 60) return null;
    return trainForest(X, y, FOREST);
  });
}

// Back the market the forests are most sure of, if that confidence clears the
// price by a margin. Confidence, not raw EV — EV alone just buys longshots.
function bestPick(models, g, floor, margin) {
  const x = vec(g);
  if (!x) return null;
  let best = null;
  for (const m of MARKETS) {
    const model = models[m.id];
    if (!model) continue;
    const price = n(m.priceOf(g));
    if (price == null || price <= 1) continue;
    const p = predictOne(model, x);
    if (!best || p > best.p) best = { selection: m.sel, label: m.label, id: m.id, price, p, ev: p * price };
  }
  if (!best) return null;
  if (best.p < floor) return null;
  if (best.ev < 1 + margin) return null;
  return best;
}

function evalSet(models, games, floor, margin) {
  let nn = 0, wins = 0, implied = 0, ret = 0;
  for (const g of games) {
    const pick = bestPick(models, g, floor, margin);
    if (!pick) continue;
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    const m = MARKETS[pick.id];
    nn++;
    if (m.won(hg, ag)) { wins++; ret += pick.price; }
    if (pick.price > 1) implied += 1 / pick.price;
  }
  const be = nn ? implied / nn : 0;
  const hit = nn ? wins / nn : 0;
  const [lo, hi] = wilson(wins, nn);
  return { n: nn, wins, hit, be, lo, hi, roi: nn ? (ret - nn) / nn : 0 };
}

// Tune the confidence floor and margin on the validation slice. The only cut we
// will deploy is one whose Wilson FLOOR already clears break-even on validation
// — i.e. one that is statistically real, not a lucky high-volume slice. If none
// qualifies, we hand back a null cut and the Finder stays silent by design. This
// is what stops it fooling itself: a looser "just positive" rule overfits and
// loses out-of-sample, which is exactly the trap the hold-out is meant to catch.
function tune(models, games) {
  const floors = [0.60, 0.65, 0.70, 0.72, 0.76, 0.80];
  const margins = [0, 0.03, 0.05, 0.08];
  let best = null;
  for (const f of floors) {
    for (const mg of margins) {
      const s = evalSet(models, games, f, mg);
      if (s.n < 30) continue;
      if (!(s.lo > s.be)) continue;            // must be proven on validation
      const gap = s.lo - s.be;
      if (!best || gap > best.gap) best = { floor: f, margin: mg, gap, stats: s };
    }
  }
  return best || { floor: null, margin: null, gap: -1, stats: null };
}

async function loadSettled() {
  const rows = await sql`
    SELECT game_id, league, kickoff,
           ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2,
           ht_home, ht_draw, ht_away, r_hg, r_ag, r_hthg, r_htag
    FROM games WHERE r_status IS NOT NULL
      AND r_hg IS NOT NULL AND r_ag IS NOT NULL
    ORDER BY kickoff ASC
    LIMIT 6000`;
  return rows.map((r) => ({
    id: r.game_id,
    league: r.league || "",
    kickoff: r.kickoff ? Number(r.kickoff) : null,
    ft: { home: r.ft_home, draw: r.ft_draw, away: r.ft_away },
    dc: r.dc_1x == null ? null : { home_draw: r.dc_1x, home_away: r.dc_12, draw_away: r.dc_x2 },
    ht: r.ht_home == null ? null : { home: r.ht_home, draw: r.ht_draw, away: r.ht_away },
    res: { hg: r.r_hg, ag: r.r_ag, hthg: r.r_hthg, htag: r.r_htag },
  }));
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

export async function trainFinder() {
  const games = await loadSettled();
  if (games.length < 200) {
    const out = {
      ok: false, silent: true,
      reason: "Need about 200 settled games before the learner can judge anything. " + games.length + " so far.",
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

  const fitModels = trainMarkets(fitGames);
  const chosen = tune(fitModels, valGames);
  const pct = (x) => (x * 100).toFixed(1) + "%";

  // Production forests see everything but the hold-out (so the number below stays honest).
  const prod = trainMarkets(games.slice(0, cutTest));
  const keys = featureUse({ trees: prod.filter(Boolean).flatMap((m) => m.trees) }, NAMES).slice(0, 6);
  const readout = keys.length ? ("Watching " + keys.map((k) => k.name).join(", ") + ".") : "No stable split yet.";

  // No cut proved itself on validation → nothing to deploy, stay silent.
  if (chosen.floor == null) {
    const out = {
      ok: true, silent: true, proven: false,
      reason: "No learned rule beats the prices out-of-sample yet on " + games.length + " games. Finder picks nothing — that is a real answer, not a bug. It keeps watching as games pile up.",
      nGames: games.length, nFit: fitGames.length, nVal: valGames.length, nTest: testGames.length,
      floor: null, margin: null, holdout: null, keys, readout, trainedAt: Date.now(), models: prod,
    };
    await putModel(out);
    return out;
  }

  const holdout = evalSet(prod, testGames, chosen.floor, chosen.margin);

  // A validation-proven cut still has to hold on the untouched hold-out.
  const positive = holdout.n >= 35 && holdout.hit > holdout.be && holdout.roi > 0;
  const proven = positive && holdout.lo > holdout.be;
  const silent = !positive;

  const out = {
    ok: true,
    silent,
    proven,
    reason: silent
      ? "A rule looked real in training but did not hold on the untouched hold-out (" + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + "). Finder stays quiet."
      : (proven
        ? "Proven out-of-sample: " + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + ", floor " + pct(holdout.lo) + " clears it. ROI " + (holdout.roi >= 0 ? "+" : "") + pct(holdout.roi) + "."
        : "Positive out-of-sample: " + pct(holdout.hit) + " vs break-even " + pct(holdout.be) + ", ROI " + (holdout.roi >= 0 ? "+" : "") + pct(holdout.roi) + ". Not yet Wilson-proven — needs more games."),
    nGames: games.length,
    nFit: fitGames.length,
    nVal: valGames.length,
    nTest: testGames.length,
    floor: chosen.floor,
    margin: chosen.margin,
    holdout,
    keys,
    readout,
    trainedAt: Date.now(),
    models: prod,
  };
  await putModel(out);
  return out;
}

export async function ensureModel() {
  const cur = await loadModel();
  const age = cur?.trainedAt ? Date.now() - Number(cur.trainedAt) : Infinity;
  if (cur && cur.models && age < 12 * 3600 * 1000) return cur;
  return trainFinder();
}

export function decide(pack, g) {
  if (!pack || pack.silent || !pack.models) return null;
  return bestPick(pack.models, g, pack.floor ?? 0.70, pack.margin ?? 0.03);
}

export async function livePicks(pack) {
  if (!pack || pack.silent || !pack.models) return [];
  const cutoff = Date.now() - 2 * 60 * 1000;
  const rows = await sql`
    SELECT * FROM games
    WHERE kickoff IS NULL OR kickoff > ${cutoff}
    ORDER BY kickoff ASC NULLS LAST
    LIMIT 500`;
  const out = [];
  for (const r of rows) {
    const g = rowToGame(r);
    if (!g.upcoming && !isUpcoming(g.status, g.kickoff)) continue;
    const pick = decide(pack, g);
    if (!pick) continue;
    out.push({
      id: g.id,
      eventId: g.eventId,
      home: g.home,
      away: g.away,
      league: g.league,
      kickoff: g.kickoff,
      ft: g.ft, dc: g.dc, ht: g.ht,
      selection: pick.selection,
      label: pick.label,
      price: pick.price,
      p: pick.p,
      ev: pick.ev,
    });
  }
  out.sort((a, b) => (Number(a.kickoff) || Infinity) - (Number(b.kickoff) || Infinity));
  return out;
}
