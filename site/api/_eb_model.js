// eBasketball model — pure, no database, so the tests can drive it.
//
// The rating does not ask "who is better"; the book already knows that, team
// pick included. It asks "who keeps beating the book's own expectation". Each
// gamer's number moves on (result − book %), so it sits at 0 until someone is
// mispriced again and again. Our % is the book's, nudged by that difference,
// and the nudge stays small until both gamers have a real record.

export const SPORT = "sr:sport:153";
export const K = 0.05;          // logit points per unit of surprise
export const SHRINK_N = 30;     // games before a gamer's number counts in full
export const MIN_N = 20;        // games each before a paper pick
export const MIN_EDGE = 0.04;   // our % over the book's on the side we back
export const MAX_PRICE = 3.0;
export const PROVEN_N = 100;

const logit = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

/** "Toronto Raptors (Losmi)" -> { team: "Toronto Raptors", gamer: "Losmi" } */
export function splitName(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return { team: t, gamer: "" };
  return { team: m[1].trim(), gamer: m[2].trim() };
}

/** Gamers are only compared inside their own pool. */
export function poolOf(tourn) {
  const s = String(tourn || "").toLowerCase();
  if (s.includes("european")) return "esb-eu";
  if (s.includes("esportsbattle")) return "esb";
  if (s.includes("nba league") || s.includes("ebasket")) return "ebasket";
  return s.replace(/\(.*?\)/g, "").replace(/[^a-z0-9]+/g, "").slice(0, 24) || "other";
}

export function gamerKey(name, tourn) {
  const g = splitName(name).gamer || splitName(name).team;
  return poolOf(tourn) + "|" + g.toUpperCase().replace(/\s+/g, " ");
}

/** De-vigged home share of the two-way winner market. */
export function bookHome(hOdds, aOdds) {
  const h = Number(hOdds), a = Number(aOdds);
  if (!(h > 1) || !(a > 1)) return null;
  const ih = 1 / h, ia = 1 / a;
  return ih / (ih + ia);
}

function winnerPrices(ev) {
  for (const m of ev?.markets || []) {
    if (String(m.id) !== "219") continue;
    const out = {};
    for (const o of m.outcomes || []) {
      const p = parseFloat(o.odds);
      if (!(p > 1)) continue;
      if (String(o.id) === "4" || /^home$/i.test(o.desc || "")) out.home = p;
      else if (String(o.id) === "5" || /^away$/i.test(o.desc || "")) out.away = p;
    }
    if (out.home && out.away) return out;
  }
  return null;
}

/** SportyBet event -> stored game row shape. */
export function normaliseEB(ev, tourn) {
  if (!ev || !ev.gameId || !ev.homeTeamName || !ev.awayTeamName) return null;
  return {
    id: String(ev.gameId),
    eventId: ev.eventId || null,
    home: ev.homeTeamName,
    away: ev.awayTeamName,
    tourn: tourn || "",
    start: ev.estimateStartTime ? Number(ev.estimateStartTime) : null,
    status: ev.matchStatus || "",
    win: winnerPrices(ev),
  };
}

/** Final points off a result row, or null while it is not over. */
export function finalScore(ev) {
  if (!ev || !/^(ended|end|aet|after ot)/i.test(String(ev.matchStatus || ""))) return null;
  const m = String(ev.setScore || "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
  if (!m) return null;
  const h = Number(m[1]), a = Number(m[2]);
  if (h === a || h + a < 20) return null;
  return { home: h, away: a };
}

const weight = (n) => (Number(n) || 0) / ((Number(n) || 0) + SHRINK_N);

/** Our home % from the book and the two gamers' book-relative numbers. */
export function predict(book, H, A) {
  if (book == null) return null;
  const b = Math.min(0.98, Math.max(0.02, book));
  const shift = (H?.r || 0) * weight(H?.n) - (A?.r || 0) * weight(A?.n);
  return sigmoid(logit(b) + shift);
}

/** Learn one finished game. Mutates the two rating rows. */
export function learn(book, H, A, homeWon) {
  const y = homeWon ? 1 : 0;
  const surprise = y - book;
  H.r = (H.r || 0) + K * surprise;
  A.r = (A.r || 0) - K * surprise;
  H.n = (H.n || 0) + 1;
  A.n = (A.n || 0) + 1;
}

/** The paper pick for one game, or null. ours/book are home shares. */
export function pickOf(ours, book, win, nH, nA) {
  if (ours == null || book == null || !win) return null;
  if (Math.min(nH || 0, nA || 0) < MIN_N) return null;
  const home = ours - book >= MIN_EDGE;
  const away = (1 - ours) - (1 - book) >= MIN_EDGE;
  if (!home && !away) return null;
  const side = home ? "home" : "away";
  const price = home ? win.home : win.away;
  if (!(price > 1) || price > MAX_PRICE) return null;
  return {
    side, price,
    ours: home ? ours : 1 - ours,
    book: home ? book : 1 - book,
  };
}

function wilsonLo(w, n) {
  if (!n) return 0;
  const z = 1.96, z2 = z * z, p = w / n;
  return (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
}

/** Grade the paper picks off rows of { pre, nH, nA, win, res }, where pre is
 *  the home % written down before the result was learned. Proven only when
 *  backing every pick at its price made money and the hit rate's lower bound
 *  clears the rate those prices need to break even. */
export function grade(rows) {
  let n = 0, brier = 0, bookBrier = 0;
  const p = { n: 0, hits: 0, stake: 0, ret: 0, need: 0 };
  for (const g of rows || []) {
    if (g.pre == null || !g.win || !g.res || g.res.home === g.res.away) continue;
    const book = bookHome(g.win.home, g.win.away);
    if (book == null) continue;
    const y = g.res.home > g.res.away ? 1 : 0;
    n++;
    brier += (g.pre - y) ** 2;
    bookBrier += (book - y) ** 2;
    const pick = pickOf(g.pre, book, g.win, g.nH, g.nA);
    if (!pick) continue;
    const hit = pick.side === "home" ? y === 1 : y === 0;
    p.n++; p.stake++; p.need += 1 / pick.price;
    if (hit) { p.hits++; p.ret += pick.price; }
  }
  const roi = p.stake ? (p.ret - p.stake) / p.stake : null;
  const breakEven = p.n ? p.need / p.n : null;
  const lo = wilsonLo(p.hits, p.n);
  return {
    n,
    brier: n ? brier / n : null,
    bookBrier: n ? bookBrier / n : null,
    picks: {
      n: p.n, hits: p.hits,
      hit: p.n ? p.hits / p.n : null,
      wilson: lo, roi, breakEven,
    },
    proven: p.n >= PROVEN_N && roi > 0 && breakEven != null && lo > breakEven,
  };
}
