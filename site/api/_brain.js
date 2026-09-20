// Book is the price. We start from its 1X2, then tilt with pair history,
// this club at home, and HT vs FT. A line is featured only if our % beats 1/odd.
import { leagueBucket } from "./_shape.js";

const MAX = 6;
const CSMAX = 4;
const SHRINK = 8;

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

export function devig3(a, b, c) {
  const ia = 1 / Number(a), ib = 1 / Number(b), ic = 1 / Number(c);
  if (!(ia > 0 && ib > 0 && ic > 0)) return null;
  const s = ia + ib + ic;
  return { p1: ia / s, pX: ib / s, p2: ic / s };
}

function clamp01(x) {
  return Math.min(0.9, Math.max(0.02, x));
}

function renorm(p1, pX, p2) {
  p1 = clamp01(p1); pX = clamp01(pX); p2 = clamp01(p2);
  const s = p1 + pX + p2;
  return { p1: p1 / s, pX: pX / s, p2: p2 / s };
}

function favOf(p1, pX, p2) {
  if (p1 >= pX && p1 >= p2) return "1";
  if (p2 >= pX) return "2";
  return "X";
}

function bump(p1, pX, p2, which, t) {
  if (!t) return { p1, pX, p2 };
  if (which === "1") { p1 += t; pX -= t / 2; p2 -= t / 2; }
  else if (which === "2") { p2 += t; p1 -= t / 2; pX -= t / 2; }
  else { pX += t; p1 -= t / 2; p2 -= t / 2; }
  return renorm(p1, pX, p2);
}

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

export function pairKey(g) {
  const L = bucket(g);
  return L + "|" + clubKey(L, g.home) + "|" + clubKey(L, g.away);
}

export function homeKey(g) {
  const L = bucket(g);
  return L + "|" + clubKey(L, g.home);
}

export function fitPairs(games) {
  const pair = {}, home = {};
  for (const g of games || []) {
    const hg = g.res?.hg, ag = g.res?.ag;
    if (hg == null || ag == null) continue;
    const book = g.ft?.home > 1 ? devig3(g.ft.home, g.ft.draw, g.ft.away) : null;
    const hw = hg > ag ? 1 : 0, dr = hg === ag ? 1 : 0, aw = ag > hg ? 1 : 0;
    const pk = pairKey(g), hk = homeKey(g);
    const p = pair[pk] || (pair[pk] = { n: 0, hw: 0, dr: 0, aw: 0, imp1: 0 });
    p.n++; p.hw += hw; p.dr += dr; p.aw += aw;
    if (book) p.imp1 += book.p1;
    const h = home[hk] || (home[hk] = { n: 0, hw: 0, imp1: 0 });
    h.n++; h.hw += hw;
    if (book) h.imp1 += book.p1;
  }
  return { pair, home };
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

function residual(row, k) {
  if (!row || row.n < 6) return 0;
  const emp = row.hw / row.n;
  const imp = row.n ? row.imp1 / row.n : emp;
  const w = row.n / (row.n + k);
  return w * (emp - imp);
}

/** 1X2 from the book, tilted. CS still from the score matrix (stays ~10–15%). */
export function forecast(ratings, g, extra = {}) {
  const { lh, la, nH, nA, league } = lambdas(ratings, g);
  const grid = [];
  let csMass = 0;
  for (let h = 0; h <= MAX; h++) {
    const ph = poisson(h, lh);
    for (let a = 0; a <= MAX; a++) {
      const p = ph * poisson(a, la);
      grid.push({ h, a, score: h + ":" + a, p });
      if (h <= CSMAX && a <= CSMAX) csMass += p;
    }
  }
  const pOther = Math.max(0, 1 - csMass);
  grid.sort((x, y) => y.p - x.p);

  let pois1 = 0, poisX = 0, pois2 = 0;
  for (const c of grid) {
    if (c.h > c.a) pois1 += c.p;
    else if (c.h === c.a) poisX += c.p;
    else pois2 += c.p;
  }

  const book = g.ft?.home > 1 ? devig3(g.ft.home, g.ft.draw, g.ft.away) : null;
  let p1 = book ? book.p1 : pois1;
  let pX = book ? book.pX : poisX;
  let p2 = book ? book.p2 : pois2;

  const pairs = extra.pairs || {};
  const tPair = (extra.wPair || 0) * residual(pairs.pair?.[pairKey(g)], 12);
  ({ p1, pX, p2 } = bump(p1, pX, p2, "1", tPair));
  const tClub = (extra.wClub || 0) * residual(pairs.home?.[homeKey(g)], 20);
  ({ p1, pX, p2 } = bump(p1, pX, p2, "1", tClub));

  if (g.ht?.home > 1 && extra.wHt) {
    const ht = devig3(g.ht.home, g.ht.draw, g.ht.away);
    if (ht) {
      const bf = favOf(p1, pX, p2), hf = favOf(ht.p1, ht.pX, ht.p2);
      if (bf === hf) {
        const k = extra.wHt * 0.5;
        p1 += k * (ht.p1 - p1);
        pX += k * (ht.pX - pX);
        p2 += k * (ht.p2 - p2);
      } else {
        const k = extra.wHt * 0.3;
        p1 += k * ((book ? book.p1 : 1 / 3) - p1);
        pX += k * ((book ? book.pX : 1 / 3) - pX);
        p2 += k * ((book ? book.p2 : 1 / 3) - p2);
      }
      ({ p1, pX, p2 } = renorm(p1, pX, p2));
    }
  }

  const csOdds = g.cs || {};
  const csCells = grid.filter((c) => c.h <= CSMAX && c.a <= CSMAX);
  const cs = csCells.slice(0, 8).map((c) => {
    const v = Number(csOdds[c.score] ?? csOdds[c.score.replace(":", "-")]);
    return {
      selection: c.score,
      label: "Correct score " + c.score.replace(":", "-"),
      p: c.p,
      price: isFinite(v) && v > 1 ? v : null,
    };
  });
  if (pOther > 0.02) {
    const v = Number(csOdds.Other);
    cs.push({
      selection: "Other", label: "Correct score Other", p: pOther,
      price: isFinite(v) && v > 1 ? v : null,
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
    pred1x2: favOf(p1, pX, p2),
  };
}

export const LINES = [
  { sel: "1",  label: "Home",         pOf: (f) => f.p1,  priceOf: (g) => g.ft?.home },
  { sel: "X",  label: "Draw",         pOf: (f) => f.pX,  priceOf: (g) => g.ft?.draw },
  { sel: "2",  label: "Away",         pOf: (f) => f.p2,  priceOf: (g) => g.ft?.away },
  { sel: "1X", label: "Home or Draw", pOf: (f) => f.p1X, priceOf: (g) => g.dc?.home_draw },
  { sel: "12", label: "Home or Away", pOf: (f) => f.p12, priceOf: (g) => g.dc?.home_away },
  { sel: "X2", label: "Draw or Away", pOf: (f) => f.pX2, priceOf: (g) => g.dc?.draw_away },
];

function n(v) {
  const x = Number(v);
  return isFinite(x) && x > 1 ? x : null;
}

/** Best line where our % beats 1/odd by edgeMin. Fat 5.00 Home can win this. */
export function bestEdge(f, g, edgeMin) {
  let best = null;
  const consider = (sel, label, p, price) => {
    if (price == null || !(p > 0)) return;
    const edge = p - 1 / price;
    if (edge < edgeMin) return;
    if (!best || edge > best.edge) {
      best = { selection: sel, label, p, price, edge, ev: p * price };
    }
  };
  for (const line of LINES) consider(line.sel, line.label, line.pOf(f), n(line.priceOf(g)));
  for (const c of f.cs || []) {
    if (c.selection === "Other") continue;
    consider(c.selection, c.label, c.p, n(c.price));
  }
  return best;
}

export function bestLine(f, g, floor, margin) {
  return bestEdge(f, g, margin || 0.05);
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
