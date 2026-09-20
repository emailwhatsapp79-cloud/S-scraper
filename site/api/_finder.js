// Learns a pick from settled games. No hand-written bands, no morning/night
// labels. Memory is the games table; this re-reads the whole pile.
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
  "league", "hour", "weekday", "market",
];

const MARKETS = [
  { id: 0, sel: "1",  label: "Home",          priceOf: (g) => g.ft?.home,          won: (h, a) => h > a },
  { id: 1, sel: "X",  label: "Draw",          priceOf: (g) => g.ft?.draw,          won: (h, a) => h === a },
  { id: 2, sel: "2",  label: "Away",          priceOf: (g) => g.ft?.away,          won: (h, a) => a > h },
  { id: 3, sel: "1X", label: "Home or Draw",  priceOf: (g) => g.dc?.home_draw,     won: (h, a) => h >= a },
  { id: 4, sel: "X2", label: "Draw or Away",  priceOf: (g) => g.dc?.draw_away,     won: (h, a) => a >= h },
  { id: 5, sel: "12", label: "Home or Away",  priceOf: (g) => g.dc?.home_away,     won: (h, a) => h !== a },
];

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

function vec(g, marketId) {
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
    marketId,
  ].map((x) => (x == null || !isFinite(x) ? -1 : x));
}

function wilson(wins, n, z = 1.96) {
  if (!n) return [0, 1];
  const p = wins / n, z2 = z * z, den = 1 + z2 / n;
  const centre = p + z2 / (2 * n);
  const adj = z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n);
  return [(centre - adj) / den, (centre + adj) / den];
}

function bestPick(model, g, margin) {
  let best = null;
  for (const m of MARKETS) {
    const price = n(m.priceOf(g));
    if (price == null || price <= 1) continue;
    const x = vec(g, m.id);
    if (!x) continue;
    const p = predictOne(model, x);
    const ev = p * price;
    if (!best || ev > best.ev) {
      best = { selection: m.sel, label: m.label, price, p, ev };
    }
  }
  if (!best || best.ev < 1 + margin) return null;
  return best;
}

function evalSet(model, games, margin) {
  let n = 0, wins = 0, implied = 0, ret = 0;
  for (const g of games) {
    const pick = bestPick(model, g, margin);
    if (!pick) continue;
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    const m = MARKETS.find((x) => x.sel === pick.selection);
    const hit = m.won(hg, ag);
    n++;
    if (hit) { wins++; ret += pick.price; }
    if (pick.price > 1) implied += 1 / pick.price;
  }
  const be = n ? implied / n : 0;
  const hit = n ? wins / n : 0;
  const [lo, hi] = wilson(wins, n);
  return {
    n, wins, hit, be, lo, hi,
    roi: n ? (ret - n) / n : 0,
    edge: n >= 40 && lo > be,
  };
}

function chooseMargin(model, games) {
  const tryM = [0.02, 0.04, 0.06, 0.08, 0.1, 0.14];
  let best = { margin: 0.08, score: -1, stats: evalSet(model, games, 0.08) };
  for (const m of tryM) {
    const s = evalSet(model, games, m);
    if (s.n < 40) continue;
    const score = (s.lo - s.be) + Math.min(s.n, 200) / 2000;
    if (score > best.score) best = { margin: m, score, stats: s };
  }
  return best;
}

function rowsFor(games) {
  const X = [], y = [];
  for (const g of games) {
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    for (const m of MARKETS) {
      const price = n(m.priceOf(g));
      if (price == null || price <= 1) continue;
      const x = vec(g, m.id);
      if (!x) continue;
      X.push(x);
      y.push(m.won(hg, ag) ? 1 : 0);
    }
  }
  return { X, y };
}

async function loadSettled() {
  const rows = await sql`
    SELECT game_id, league, kickoff,
           ft_home, ft_draw, ft_away, dc_1x, dc_12, dc_x2,
           ht_home, ht_draw, ht_away, r_hg, r_ag, r_hthg, r_htag
    FROM games WHERE r_status IS NOT NULL
      AND r_hg IS NOT NULL AND r_ag IS NOT NULL
    ORDER BY kickoff ASC
    LIMIT 5000`;
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
  if (games.length < 120) {
    const out = {
      ok: false, silent: true,
      reason: "Need about 120 settled games before the learner can judge anything. " + games.length + " so far.",
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

  const { X, y } = rowsFor(fitGames);
  const model = trainForest(X, y, { nTrees: 17, maxDepth: 4, minLeaf: 35, seed: 2026 });
  const chosen = chooseMargin(model, valGames);
  const holdout = evalSet(model, testGames, chosen.margin);

  // Production forest sees all but the hold-out (the pile it is allowed to remember).
  const { X: Xp, y: yp } = rowsFor(games.slice(0, cutTest));
  const prod = trainForest(Xp, yp, { nTrees: 17, maxDepth: 4, minLeaf: 35, seed: 2026 });

  const keys = featureUse(prod, NAMES).filter((k) => k.name !== "market").slice(0, 6);
  const silent = !holdout.edge;
  const readout = keys.length
    ? ("Keying on " + keys.map((k) => k.name).join(", ") + ".")
    : "No stable split yet.";

  const out = {
    ok: true,
    silent,
    reason: silent
      ? (holdout.n < 40
        ? "Hold-out had too few picks to trust (" + holdout.n + "). Finder stays quiet."
        : "Hold-out did not beat the prices. Floor " + (holdout.lo * 100).toFixed(1) + "% vs break-even " + (holdout.be * 100).toFixed(1) + "%. Finder picks nothing.")
      : "Hold-out beat the prices. Floor " + (holdout.lo * 100).toFixed(1) + "% vs break-even " + (holdout.be * 100).toFixed(1) + "%.",
    nGames: games.length,
    nFit: fitGames.length,
    nVal: valGames.length,
    nTest: testGames.length,
    margin: chosen.margin,
    holdout,
    keys,
    readout,
    trainedAt: Date.now(),
    model: prod,
  };
  await putModel(out);
  return out;
}

export async function ensureModel() {
  const cur = await loadModel();
  const age = cur?.trainedAt ? Date.now() - Number(cur.trainedAt) : Infinity;
  if (cur && cur.model && age < 12 * 3600 * 1000) return cur;
  return trainFinder();
}

export function decide(pack, g) {
  if (!pack || pack.silent || !pack.model) return null;
  return bestPick(pack.model, g, pack.margin || 0.08);
}

export async function livePicks(pack) {
  if (!pack || pack.silent || !pack.model) return [];
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
