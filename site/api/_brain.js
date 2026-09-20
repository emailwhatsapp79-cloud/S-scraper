// One score matrix per match. Club names are IDs in this sim (England MUN
// is not Manchester United). Attack/defence come from actual goals in the
// settled pile. 1X2, DC and correct score are slices of the same grid.
import { leagueBucket } from "./_shape.js";

const MAX = 6;   // matrix for 1X2
const CSMAX = 4; // book only prices 0–4 + Other
const SHRINK = 8; // games of prior; a new club sits on the league average

export function clubKey(league, name) {
  return String(name || "").trim().toUpperCase();
}

function poisson(k, lambda) {
  if (!(lambda > 0)) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
}

function bucket(g) {
  return leagueBucket(g) || "Other";
}

/** Fit attack/defence per club, per virtual league, from finished scores. */
export function fitRatings(games) {
  const leagues = {};
  for (const g of games || []) {
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    const L = bucket(g);
    const lg = leagues[L] || (leagues[L] = { n: 0, hg: 0, ag: 0, clubs: {} });
    lg.n++; lg.hg += hg; lg.ag += ag;
    const h = clubKey(L, g.home), a = clubKey(L, g.away);
    const hc = lg.clubs[h] || (lg.clubs[h] = { n: 0, scored: 0, conceded: 0 });
    const ac = lg.clubs[a] || (lg.clubs[a] = { n: 0, scored: 0, conceded: 0 });
    hc.n++; hc.scored += hg; hc.conceded += ag;
    ac.n++; ac.scored += ag; ac.conceded += hg;
  }

  const out = {};
  for (const [L, lg] of Object.entries(leagues)) {
    if (lg.n < 12) continue;
    const avgH = lg.hg / lg.n, avgA = lg.ag / lg.n;
    const avg = (avgH + avgA) / 2 || 1;
    const clubs = {};
    for (const [id, c] of Object.entries(lg.clubs)) {
      const rawAtt = c.n ? (c.scored / c.n) / avg : 1;
      const rawDef = c.n ? (c.conceded / c.n) / avg : 1;
      const w = c.n / (c.n + SHRINK);
      clubs[id] = {
        att: w * rawAtt + (1 - w) * 1,
        def: w * rawDef + (1 - w) * 1,
        n: c.n,
      };
    }
    out[L] = { avgH, avgA, n: lg.n, clubs };
  }
  return out;
}

function lambdas(ratings, g) {
  const L = bucket(g);
  const lg = ratings?.[L];
  if (!lg) return { lh: 1.3, la: 1.1, nH: 0, nA: 0, league: L };
  const h = lg.clubs[clubKey(L, g.home)] || { att: 1, def: 1, n: 0 };
  const a = lg.clubs[clubKey(L, g.away)] || { att: 1, def: 1, n: 0 };
  return {
    lh: Math.max(0.15, lg.avgH * h.att * a.def),
    la: Math.max(0.15, lg.avgA * a.att * h.def),
    nH: h.n, nA: a.n, league: L,
  };
}

/** Full grid + every readout we show. Book prices are attached when present. */
export function forecast(ratings, g) {
  const { lh, la, nH, nA, league } = lambdas(ratings, g);
  const grid = [];
  let mass = 0, csMass = 0;
  for (let h = 0; h <= MAX; h++) {
    const ph = poisson(h, lh);
    for (let a = 0; a <= MAX; a++) {
      const p = ph * poisson(a, la);
      mass += p;
      grid.push({ h, a, score: h + ":" + a, p });
      if (h <= CSMAX && a <= CSMAX) csMass += p;
    }
  }
  const pOther = Math.max(0, 1 - csMass);
  grid.sort((x, y) => y.p - x.p);

  let p1 = 0, pX = 0, p2 = 0;
  for (const c of grid) {
    if (c.h > c.a) p1 += c.p;
    else if (c.h === c.a) pX += c.p;
    else p2 += c.p;
  }

  const csOdds = g.cs || {};
  const csCells = grid.filter((c) => c.h <= CSMAX && c.a <= CSMAX);
  const cs = csCells.slice(0, 8).map((c) => ({
    selection: c.score,
    label: "Correct score " + c.score.replace(":", "-"),
    p: c.p,
    price: Number(csOdds[c.score]) || null,
  }));
  if (pOther > 0.02) {
    cs.push({
      selection: "Other",
      label: "Correct score Other",
      p: pOther,
      price: Number(csOdds.Other) || null,
    });
  }

  const top = csCells[0] || grid[0];
  return {
    league, nH, nA, lh, la,
    p1, pX, p2,
    p1X: p1 + pX,
    pX2: pX + p2,
    p12: p1 + p2,
    topCs: top ? top.score : "0:0",
    pCs: top ? top.p : 0,
    cs,
    pred1x2: p1 >= pX && p1 >= p2 ? "1" : p2 >= pX ? "2" : "X",
  };
}

export const LINES = [
  { sel: "1",  label: "Home",         pOf: (f) => f.p1,  priceOf: (g) => g.ft?.home },
  { sel: "X",  label: "Draw",         pOf: (f) => f.pX,  priceOf: (g) => g.ft?.draw },
  { sel: "2",  label: "Away",         pOf: (f) => f.p2,  priceOf: (g) => g.ft?.away },
  { sel: "1X", label: "Home or Draw", pOf: (f) => f.p1X, priceOf: (g) => g.dc?.home_draw },
  { sel: "X2", label: "Draw or Away", pOf: (f) => f.pX2, priceOf: (g) => g.dc?.draw_away },
  { sel: "12", label: "Home or Away", pOf: (f) => f.p12, priceOf: (g) => g.dc?.home_away },
];

function n(v) {
  const x = Number(v);
  return isFinite(x) && x > 1 ? x : null;
}

/** Best line whose confidence both clears a floor and beats the price. */
export function bestLine(f, g, floor, margin) {
  let best = null;
  const consider = (sel, label, p, price) => {
    if (price == null || !(p >= floor)) return;
    const ev = p * price;
    if (ev < 1 + margin) return;
    const gap = p - 1 / price;
    if (!best || gap > best.gap) best = { selection: sel, label, p, price, ev, gap };
  };
  for (const line of LINES) consider(line.sel, line.label, line.pOf(f), n(line.priceOf(g)));
  for (const c of f.cs || []) {
    if (c.selection === "Other") continue;
    consider(c.selection, c.label, c.p, n(c.price));
  }
  return best;
}

export function wonSel(sel, hg, ag) {
  if (hg == null || ag == null) return null;
  if (sel === "1") return hg > ag;
  if (sel === "X") return hg === ag;
  if (sel === "2") return ag > hg;
  if (sel === "1X") return hg >= ag;
  if (sel === "12") return hg !== ag;
  if (sel === "X2") return ag >= hg;
  if (sel === "Other") return hg > 4 || ag > 4;
  const m = String(sel).match(/^(\d+):(\d+)$/);
  if (m) return hg === Number(m[1]) && ag === Number(m[2]);
  return null;
}
