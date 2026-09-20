// Extra-trees forest. We write the learning procedure, never a threshold.
// Splits, depth, and which numbers matter are chosen from the rows.

function mulberry(seed) {
  let a = (seed >>> 0) || 1;
  return function () {
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function gini(w, n) {
  if (n <= 0) return 0;
  const p = w / n;
  return 2 * p * (1 - p);
}

function pickFeat(rng, nFeat, mtry, out) {
  out.length = 0;
  const used = new Uint8Array(nFeat);
  let k = 0;
  while (k < mtry && k < nFeat) {
    const f = Math.floor(rng() * nFeat);
    if (used[f]) continue;
    used[f] = 1;
    out.push(f);
    k++;
  }
  if (!out.length) out.push(0);
  return out;
}

function grow(X, y, idx, depth, maxDepth, minLeaf, mtry, rng, featBuf) {
  let wins = 0;
  for (let i = 0; i < idx.length; i++) if (y[idx[i]]) wins++;
  const n = idx.length;
  const p = (wins + 1) / (n + 2);
  if (depth >= maxDepth || n < minLeaf * 2 || wins === 0 || wins === n) {
    return { p, n };
  }

  pickFeat(rng, X[0].length, mtry, featBuf);
  const parent = gini(wins, n);
  let bestGain = 0, bestF = -1, bestT = 0;

  for (let fi = 0; fi < featBuf.length; fi++) {
    const f = featBuf[fi];
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const v = X[idx[i]][f];
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) continue;
    for (let k = 0; k < 7; k++) {
      const t = lo + (k + 1) / 8 * (hi - lo);
      let lN = 0, lW = 0, rN = 0, rW = 0;
      for (let i = 0; i < n; i++) {
        const j = idx[i];
        const v = X[j][f];
        if (!isFinite(v) || v <= t) {
          lN++; if (y[j]) lW++;
        } else {
          rN++; if (y[j]) rW++;
        }
      }
      if (lN < minLeaf || rN < minLeaf) continue;
      const gain = parent - (lN / n) * gini(lW, lN) - (rN / n) * gini(rW, rN);
      if (gain > bestGain) { bestGain = gain; bestF = f; bestT = t; }
    }
  }

  if (bestF < 0 || bestGain < 1e-6) return { p, n };

  const left = [], right = [];
  for (let i = 0; i < n; i++) {
    const j = idx[i];
    const v = X[j][bestF];
    if (!isFinite(v) || v <= bestT) left.push(j);
    else right.push(j);
  }
  return {
    f: bestF, t: bestT,
    l: grow(X, y, left, depth + 1, maxDepth, minLeaf, mtry, rng, featBuf),
    r: grow(X, y, right, depth + 1, maxDepth, minLeaf, mtry, rng, featBuf),
  };
}

function walk(node, x) {
  if (node.p != null && node.l == null) return node.p;
  const v = x[node.f];
  if (!isFinite(v) || v <= node.t) return walk(node.l, x);
  return walk(node.r, x);
}

function countSplits(node, counts) {
  if (!node || node.l == null) return;
  counts[node.f] = (counts[node.f] || 0) + 1;
  countSplits(node.l, counts);
  countSplits(node.r, counts);
}

export function trainForest(X, y, opts = {}) {
  const nTrees = opts.nTrees || 17;
  const maxDepth = opts.maxDepth || 4;
  const minLeaf = opts.minLeaf || 35;
  const seed = opts.seed || 2026;
  const mtry = opts.mtry || Math.max(3, Math.floor(Math.sqrt(X[0].length)));
  const rng = mulberry(seed);
  const trees = [];
  const featBuf = [];
  const all = X.map((_, i) => i);

  for (let t = 0; t < nTrees; t++) {
    const bag = [];
    for (let i = 0; i < all.length; i++) bag.push(all[Math.floor(rng() * all.length)]);
    trees.push(grow(X, y, bag, 0, maxDepth, minLeaf, mtry, rng, featBuf));
  }
  return { trees, nTrees, maxDepth, minLeaf, mtry, seed };
}

export function predictOne(model, x) {
  const trees = model.trees || [];
  if (!trees.length) return 0.5;
  let s = 0;
  for (let i = 0; i < trees.length; i++) s += walk(trees[i], x);
  return s / trees.length;
}

export function featureUse(model, names) {
  const counts = {};
  for (const tr of model.trees || []) countSplits(tr, counts);
  const rows = Object.keys(counts).map((k) => ({
    i: Number(k),
    name: names[Number(k)] || ("f" + k),
    n: counts[k],
  }));
  rows.sort((a, b) => b.n - a.n);
  return rows;
}
