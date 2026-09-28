import test from "node:test";
import assert from "node:assert/strict";
import { fairShares, scoresFromWin, tennisCall, normaliseTennis } from "../site/api/_tennis.js";
import { quote, buildOrder } from "../site/api/_fc.js";

test("four set scores add up to the match winner", () => {
  const shares = fairShares([
    { probability: "0.40" },
    { probability: "0.22" },
    { probability: "0.18" },
    { probability: "0.20" },
  ]);
  const scores = ["2:0", "2:1", "1:2", "0:2"].map((sel, i) => ({ sel, p: shares[i] }));
  const call = tennisCall(scores);
  assert.equal(call.side, "home");
  assert.equal(call.score, "2:0");
  assert.ok(Math.abs(call.home - 0.62) < 0.001);
  const made = scoresFromWin(0.75);
  const back = tennisCall(made);
  assert.ok(Math.abs(back.home - 0.75) < 0.01);
  assert.ok(Math.abs(made.reduce((s, x) => s + x.p, 0) - 1) < 0.001);
});

test("a tennis set score books market 199 with its specifier", () => {
  const ev = {
    eventId: "sr:match:1",
    sport: { id: "sr:sport:5" },
    markets: [{
      id: "199", desc: "Correct Score", specifier: "variant=sr:correct_score:bestof:3", product: 3,
      outcomes: [{ id: "sr:correct_score:bestof:3:7", desc: "0:2", odds: "2.05", isActive: 1, probability: "0.45" }],
    }],
  };
  const q = quote(ev, "0:2");
  assert.equal(q.marketId, "199");
  assert.equal(q.outcomeId, "sr:correct_score:bestof:3:7");
  assert.equal(q.specifier, "variant=sr:correct_score:bestof:3");
  assert.equal(q.sportId, "sr:sport:5");
  const order = buildOrder([{
    eventId: q.eventId, marketId: q.marketId, outcomeId: q.outcomeId,
    sportId: q.sportId, specifier: q.specifier, product: "3", price: q.odds,
  }], 100, null);
  assert.equal(order.ticket.selections[0].specifier, "variant=sr:correct_score:bestof:3");
  assert.match(order.ticket.selections[0].id, /199\/sr:correct_score:bestof:3:7\?variant=sr:correct_score:bestof:3$/);

  const game = normaliseTennis({
    eventId: "sr:match:1", gameId: "9", matchStatus: "Not start",
    estimateStartTime: Date.now() + 3600000,
    homeTeamName: "Fokina, Alejandro", awayTeamName: "Basilashvili, Nikoloz",
    markets: [
      { id: "186", desc: "Winner", product: 3, outcomes: [
        { id: "4", desc: "Home", odds: "2.95", isActive: 1, probability: "0.32" },
        { id: "5", desc: "Away", odds: "1.43", isActive: 1, probability: "0.68" },
      ] },
      { id: "199", desc: "Correct Score", specifier: "variant=sr:correct_score:bestof:3", outcomes: [
        { id: "sr:correct_score:bestof:3:4", desc: "2:0", odds: "4.85", isActive: 1, probability: "0.18" },
        { id: "sr:correct_score:bestof:3:5", desc: "2:1", odds: "6.00", isActive: 1, probability: "0.14" },
        { id: "sr:correct_score:bestof:3:6", desc: "1:2", odds: "3.60", isActive: 1, probability: "0.26" },
        { id: "sr:correct_score:bestof:3:7", desc: "0:2", odds: "2.05", isActive: 1, probability: "0.42" },
      ] },
    ],
  }, "ATP Chengdu");
  assert.equal(game.call.side, "away");
  assert.equal(game.call.score, "0:2");
  assert.equal(game.selectionRefs["0:2"].specifier, "variant=sr:correct_score:bestof:3");
  assert.equal(game.derived, false);
});
