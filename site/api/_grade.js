// Table tennis holdout grading — pure, so the tests can drive it without a database.

function wilsonLo(w, n) {
  if (!n) return 0;
  const z = 1.96, z2 = z * z, p = w / n;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

function bookShares(h, a) {
  if (!(h > 1) || !(a > 1)) return null;
  const ih = 1 / h, ia = 1 / a;
  return { home: ih / (ih + ia), away: ia / (ih + ia) };
}

/** Grade { pre, win, res } rows, where pre is our home % written down before
 *  the result was learned. */
export function gradeHoldout(rows) {
  let n = 0, hits = 0;
  const beat = { n: 0, hits: 0, edge: 0, stake: 0, ret: 0, need: 0 };
  const copy = { n: 0, hits: 0 };
  for (const g of rows || []) {
    if (!(g.win.home > 1) || !(g.win.away > 1) || g.res.home === g.res.away) continue;
    if (!(g.pre >= 0 && g.pre <= 100)) continue;
    const book = bookShares(g.win.home, g.win.away);
    if (!book) continue;
    const ourH = g.pre >= 50;
    const oursP = ourH ? g.pre : 100 - g.pre;
    const bookP = Math.round((ourH ? book.home : book.away) * 100);
    const bookH = book.home >= book.away;
    const hit = ourH ? g.res.home > g.res.away : g.res.away > g.res.home;
    const price = ourH ? g.win.home : g.win.away;
    n++; if (hit) hits++;
    if (ourH === bookH && oursP >= 60) {
      const edge = oursP - bookP;
      if (edge >= 5) {
        beat.n++; beat.edge += edge; beat.stake += 1; beat.need += 1 / price;
        if (hit) { beat.hits++; beat.ret += price; }
      } else {
        copy.n++; if (hit) copy.hits++;
      }
    }
  }
  const roi = beat.stake ? (beat.ret - beat.stake) / beat.stake : null;
  const breakEven = beat.n ? beat.need / beat.n : null;
  const wilson = wilsonLo(beat.hits, beat.n);
  return {
    n,
    hit: n ? hits / n : null,
    beat: {
      n: beat.n, hits: beat.hits,
      hit: beat.n ? beat.hits / beat.n : null,
      wilson,
      edge: beat.n ? beat.edge / beat.n : null,
      roi,
      breakEven,
    },
    copy: {
      n: copy.n, hits: copy.hits,
      hit: copy.n ? copy.hits / copy.n : null,
    },
    proven: beat.n >= 30 && roi != null && roi > 0 && breakEven != null && wilson > breakEven,
  };
}
