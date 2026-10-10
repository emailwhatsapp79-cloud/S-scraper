// Red flags on a live TT / tennis leg — the signs that a short-priced pick is
// going sideways before the score says it has lost:
//   - SportyBet's own live price for the pick has drifted well out
//     (1.11 booked -> 1.65 live = the book now rates it ~60%, not ~88%);
//   - the pick, booked as the favourite, has dropped a set;
//   - it is "dragging head to head": sets it was meant to win easily went to
//     the wire (11-9, 12-10; 7-5 / 7-6 in tennis);
//   - it is behind late in the set being played.
// Pure, so the tests can drive it. Returns { level, score, reasons }.

function pickedHome(sel) {
  const s = String(sel || "");
  if (s === "1") return true;
  if (s === "2") return false;
  const m = s.match(/^(\d+):(\d+)$/);
  return m ? Number(m[1]) > Number(m[2]) : null;
}

function pairs(text) {
  return String(text || "").split(/[\s,]+/).map((x) => x.match(/^(\d+):(\d+)$/))
    .filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
}

export function legFlags(leg) {
  const reasons = [];
  let score = 0;
  const home = pickedHome(leg && leg.selection);
  if (home == null || !leg || leg.won === "yes" || leg.won === "no") return { level: "none", score, reasons };
  const tn = leg.sport === "tn";
  const price = Number(leg.price) || 0;
  const fav = price > 1 && price <= (tn ? 1.5 : 1.45);

  const live = Number(leg.live_price) || 0;
  if (live > 1 && price > 1) {
    const now = Math.round(100 / live);
    if (live >= Math.max(2.0, price * 1.6)) {
      score += 2; reasons.push(`live odds ${price.toFixed(2)} → ${live.toFixed(2)} (SportyBet now gives it ~${now}%)`);
    } else if (live >= Math.max(1.6, price * 1.3)) {
      score += 1; reasons.push(`live odds drifting ${price.toFixed(2)} → ${live.toFixed(2)} (~${now}%)`);
    }
  }

  const sets = pairs(leg.game_score);
  const ss = String(leg.set_score || "").match(/^(\d+)\s*:\s*(\d+)$/);
  const doneSets = ss ? Number(ss[1]) + Number(ss[2]) : 0;
  sets.slice(0, doneSets).forEach(([a, b], i) => {
    const mine = home ? a : b, theirs = home ? b : a;
    if (mine < theirs && fav) { score += 2; reasons.push(`lost set ${i + 1} ${mine}–${theirs}`); }
    else if (mine > theirs && fav) {
      const tight = tn ? (mine === 7 && theirs >= 5) : (mine >= 11 && mine - theirs <= 2);
      if (tight) { score += 1; reasons.push(`only edged set ${i + 1} ${mine}–${theirs}`); }
    }
  });

  // The set being played (TT points from 'played'; tennis games from the open set).
  const cur = tn ? sets[doneSets] : pairs(leg.played)[0];
  if (cur) {
    const mine = home ? cur[0] : cur[1], theirs = home ? cur[1] : cur[0];
    const late = tn ? theirs >= 4 : theirs >= 7;
    if (late && theirs - mine >= 2) { score += 1; reasons.push(`behind ${mine}–${theirs} in set ${doneSets + 1}`); }
  }

  return { level: score >= 2 ? "danger" : score >= 1 ? "watch" : "none", score, reasons };
}
