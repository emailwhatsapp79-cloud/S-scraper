// Walk-forward vFootball pattern: team Elo + the de-vigged book.
// Graded only on the newest slice it has not trained on. If that slice does
// not beat the prices, we say so and pick nothing.
import { sql } from "./_db.js";
import { settledGames } from "./_results.js";

function threeWay(ft) {
  const h = Number(ft?.home), d = Number(ft?.draw), a = Number(ft?.away);
  if (!(h > 1) || !(d > 1) || !(a > 1)) return null;
  const ih = 1 / h, id = 1 / d, ia = 1 / a, s = ih + id + ia;
  return { H: ih / s, D: id / s, A: ia / s };
}

function ftOut(res) {
  if (res == null || res.hg == null || res.ag == null) return null;
  if (res.hg > res.ag) return "H";
  if (res.ag > res.hg) return "A";
  return "D";
}

function eloP(eh, ea) {
  return 1 / (1 + 10 ** ((ea - eh) / 400));
}

function wilsonLo(w, n) {
  if (!n) return 0;
  const z = 1.96, p = w / n, d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * n)) / n);
  return (c - m) / d;
}

function blend(book, pHomeWin) {
  // Elo only splits home/away; draw stays with the book.
  const pH = 0.4 * pHomeWin * (1 - book.D) + 0.6 * book.H;
  const pA = 0.4 * (1 - pHomeWin) * (1 - book.D) + 0.6 * book.A;
  let pD = 1 - pH - pA;
  if (pD < 0.05) pD = 0.05;
  const s = pH + pD + pA;
  return { H: pH / s, D: pD / s, A: pA / s };
}

function dcOf(side, dc, ft) {
  if (side === "H") return dc?.home_draw ?? (ft ? Math.round(100 / (1 / ft.home + 1 / ft.draw)) / 100 : null);
  if (side === "A") return dc?.draw_away ?? (ft ? Math.round(100 / (1 / ft.away + 1 / ft.draw)) / 100 : null);
  return null;
}

export function fitVF(games) {
  const players = {};
  const P = (n) => {
    const k = String(n || "").toUpperCase().trim() || "?";
    return players[k] || (players[k] = { n: 0, elo: 1500 });
  };
  const settled = (games || [])
    .filter((g) => ftOut(g.res) && g.ft && g.home && g.away)
    .sort((a, b) => (a.kickoff || 0) - (b.kickoff || 0));
  const cut = Math.max(80, Math.floor(settled.length * 0.8));
  const bt = { n: 0, hit: 0, bookHit: 0, brier: 0, bookBrier: 0, dcN: 0, dcHit: 0, dcStake: 0, dcRet: 0 };

  const step = (g, grade) => {
    const y = ftOut(g.res);
    const book = threeWay(g.ft);
    if (!y || !book) return;
    const H = P(g.home), A = P(g.away);
    const pWin = eloP(H.elo, A.elo);
    const m = blend(book, pWin);
    if (grade) {
      const pred = m.H >= m.A && m.H >= m.D ? "H" : m.A >= m.D ? "A" : "D";
      const bpred = book.H >= book.A && book.H >= book.D ? "H" : book.A >= book.D ? "A" : "D";
      bt.n++;
      if (pred === y) bt.hit++;
      if (bpred === y) bt.bookHit++;
      const oh = y === "H" ? 1 : 0, od = y === "D" ? 1 : 0, oa = y === "A" ? 1 : 0;
      bt.brier += (m.H - oh) ** 2 + (m.D - od) ** 2 + (m.A - oa) ** 2;
      bt.bookBrier += (book.H - oh) ** 2 + (book.D - od) ** 2 + (book.A - oa) ** 2;
      const side = m.H >= m.A ? "H" : "A";
      const pDC = side === "H" ? m.H + m.D : m.A + m.D;
      const price = dcOf(side, g.dc, g.ft);
      if (price > 1.05 && pDC > 1 / price + 0.02) {
        const won = side === "H" ? y !== "A" : y !== "H";
        bt.dcN++;
        bt.dcStake++;
        if (won) { bt.dcHit++; bt.dcRet += price; }
      }
    }
    const yH = y === "H" ? 1 : y === "D" ? 0.5 : 0;
    const k = 16;
    H.elo += k * (yH - pWin);
    A.elo += k * ((1 - yH) - (1 - pWin));
    H.n++; A.n++;
  };

  for (let i = 0; i < settled.length; i++) step(settled[i], i >= cut);
  const n = bt.n || 1;
  const dcRoi = bt.dcN ? (bt.dcRet - bt.dcStake) / bt.dcStake : null;
  const dcLo = wilsonLo(bt.dcHit, bt.dcN);
  const edge = bt.dcN >= 40 && dcRoi != null && dcRoi > 0 && (bt.brier / n) < (bt.bookBrier / n);
  return {
    players,
    nGames: settled.length,
    holdout: {
      n: bt.n,
      hit: bt.n ? bt.hit / bt.n : null,
      bookHit: bt.n ? bt.bookHit / bt.n : null,
      brier: bt.n ? bt.brier / bt.n : null,
      bookBrier: bt.n ? bt.bookBrier / bt.n : null,
      dcN: bt.dcN,
      dcHit: bt.dcN ? bt.dcHit / bt.dcN : null,
      dcRoi,
      dcLo,
    },
    edge: !!edge,
  };
}

export function forecastVF(pack, g) {
  const book = threeWay(g.ft);
  if (!book) return null;
  const kH = String(g.home || "").toUpperCase().trim();
  const kA = String(g.away || "").toUpperCase().trim();
  const H = (pack.players || {})[kH] || { elo: 1500, n: 0 };
  const A = (pack.players || {})[kA] || { elo: 1500, n: 0 };
  const m = blend(book, eloP(H.elo, A.elo));
  const side = m.H >= m.A ? "H" : "A";
  const pDC = side === "H" ? m.H + m.D : m.A + m.D;
  const price = dcOf(side, g.dc, g.ft);
  const label = side === "H" ? "Home or Draw" : "Draw or Away";
  const take = pack.edge && price > 1.05 && pDC > 1 / price + 0.02 && Math.min(H.n, A.n) >= 5;
  return {
    p: m,
    nH: H.n, nA: A.n,
    side, label, price, pDC,
    take: !!take,
  };
}

let _pack = null;
let _packAt = 0;

async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS vf_model (
    k TEXT PRIMARY KEY,
    pack TEXT,
    built_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

export async function rebuildVF() {
  await ensureTable();
  const games = await settledGames(8000);
  const raw = fitVF(games);
  const data = {
    players: raw.players,
    nGames: raw.nGames,
    holdout: raw.holdout,
    edge: raw.edge,
    builtAt: new Date().toISOString(),
  };
  const json = JSON.stringify(data);
  await sql`
    INSERT INTO vf_model (k, pack, built_at) VALUES ('pack', ${json}, ${data.builtAt})
    ON CONFLICT (k) DO UPDATE SET pack = ${json}, built_at = ${data.builtAt}`;
  _pack = data; _packAt = Date.now();
  return data;
}

export async function getVFPack() {
  if (_pack && Date.now() - _packAt < 60 * 1000) return _pack;
  await ensureTable();
  const rows = await sql`SELECT pack, built_at FROM vf_model WHERE k = 'pack'`;
  if (rows[0]?.pack) {
    try {
      _pack = JSON.parse(rows[0].pack);
      _packAt = Date.now();
      return _pack;
    } catch { /* rebuild */ }
  }
  return await rebuildVF();
}
