import test from "node:test";
import assert from "node:assert/strict";
import { toSelection } from "../site/api/_share.js";
import { fairShares, scoresFromWin, tennisCall, normaliseTennis, shiftCall, nameKey, scoreEdge, recordVerdict, applyRecord, stanceOf, parsePredix, parseTpTips, readOutside, applyOutside } from "../site/api/_tennis.js";
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

test("the record keeps the green score only when our number is closer", () => {
  const many = (n, hit, ours, book) => Array.from({ length: n }, () => ({ hit, ours, book }));
  assert.equal(recordVerdict(many(5, false, 40, 15)).used, "early");
  assert.equal(recordVerdict(many(12, false, 40, 15)).used, "book");
  assert.equal(recordVerdict(many(12, true, 40, 15)).used, "ours");
  const games = [{ ahead: { sel: "2:1", ours: 39, book: 21 }, context: { note: "Ahead of the book on 2:1" } }];
  applyRecord(games, { used: "book" });
  assert.equal(games[0].ahead, undefined);
  assert.equal(games[0].context.note, "");
  const stay = [{ ahead: { sel: "1:2" }, context: { note: "Ahead of the book on 1:2" } }];
  applyRecord(stay, { used: "early" });
  assert.equal(stay[0].ahead.sel, "1:2");
});

test("recent straight sets can get ahead of the book score", () => {
  const rows = (sel, n) => Array.from({ length: n }, () => ({ sel, surface: "hardcourt_outdoor" }));
  const home = rows("2:0", 8).concat(rows("0:2", 2));
  const away = rows("0:2", 8).concat(rows("2:0", 2));
  const book = [
    { sel: "2:0", p: 30 }, { sel: "2:1", p: 30 },
    { sel: "1:2", p: 20 }, { sel: "0:2", p: 20 },
  ];
  const hit = scoreEdge(0.6, home, away, book, "hardcourt_outdoor");
  assert.equal(hit.edge.sel, "2:0");
  assert.ok(hit.edge.gap >= 0.08);
  const quiet = scoreEdge(0.6, rows("2:1", 4), rows("1:2", 4), book, "");
  assert.equal(quiet, null);
  const homeDecider = rows("2:1", 8).concat(rows("2:0", 2));
  const awayDecider = rows("1:2", 8).concat(rows("0:2", 2));
  const short = [
    { sel: "2:0", p: 46 }, { sel: "2:1", p: 18 },
    { sel: "1:2", p: 22 }, { sel: "0:2", p: 14 },
  ];
  const dog = scoreEdge(0.64, homeDecider, awayDecider, short, "hardcourt_outdoor");
  if (dog && dog.edge) {
    const mode = dog.ours.reduce((a, b) => (b.p > a.p ? b : a));
    assert.equal(dog.edge.sel, mode.sel);
    assert.ok(dog.edge.ours >= 0.4);
  }
});

test("a short book price is the pick, and a 5.00 on the other side is not", () => {
  const book = [
    { sel: "2:0", p: 78, odds: 1.16 },
    { sel: "2:1", p: 12, odds: 5.1 },
    { sel: "1:2", p: 6, odds: 9 },
    { sel: "0:2", p: 4, odds: 12 },
  ];
  const aligned = stanceOf([
    { sel: "2:0", p: 0.8 }, { sel: "2:1", p: 0.1 },
    { sel: "1:2", p: 0.06 }, { sel: "0:2", p: 0.04 },
  ], book);
  assert.equal(aligned.ahead, null);
  assert.equal(aligned.withBook.sel, "2:0");
  const fight = stanceOf([
    { sel: "2:0", p: 0.5 }, { sel: "2:1", p: 0.3 },
    { sel: "1:2", p: 0.12 }, { sel: "0:2", p: 0.08 },
  ], book);
  assert.equal(fight.ahead, null);
  assert.equal(fight.withBook, null);
  const little = stanceOf([
    { sel: "2:0", p: 0.7 }, { sel: "2:1", p: 0.16 },
    { sel: "1:2", p: 0.08 }, { sel: "0:2", p: 0.06 },
  ], [
    { sel: "2:0", p: 60, odds: 1.55 },
    { sel: "2:1", p: 22, odds: 3.6 },
    { sel: "1:2", p: 12, odds: 6 },
    { sel: "0:2", p: 6, odds: 9 },
  ]);
  assert.equal(little.ahead.sel, "2:0");
  assert.ok(little.ahead.gap >= 0.06 && little.ahead.gap <= 0.18);
});

test("an outside sure winner only allows straight sets, a close match allows 2-1", () => {
  const predix = `
    player-name player-one"><a href="/a">Daniil Medvedev</a>
    player-two"><a href="/b">Roman Safiullin</a>
    aria-valuenow="70.3" aria-valuenow="29.7"
    Most likely set score: 2-0 <small class="ai-extra-prob">(45%)</small>
    player-name player-one"><a href="/c">Roman One</a>
    player-two"><a href="/d">Roman Two</a>
    aria-valuenow="51.4" aria-valuenow="48.6"
    Most likely set score: 2-1 <small class="ai-extra-prob">(31%)</small>
  `;
  const rows = parsePredix(predix);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].score, "2:0");
  const tips = parseTpTips('visually-hidden">D. Medvedev vs R. Safiullin, ATP, Upcoming. Best AI tip: R. Safiullin, odds 2.4, confidence 7.2 out of 10.</span>');
  assert.equal(tips[0].pick, "R. Safiullin");
  const sureGame = {
    home: "Medvedev, Daniil", away: "Safiullin, Roman",
    call: { home: 68, away: 32, score: "2:1", scoreP: 30 },
    scores: [{ sel: "2:0", odds: 1.4, p: 60 }, { sel: "2:1", odds: 4.5, p: 22 }],
    ahead: { sel: "2:1", ours: 30, book: 18 },
    context: { note: "A little ahead of the book on 2:1" },
  };
  const split = readOutside(sureGame, { predix: rows, tp: tips });
  assert.equal(split.split, true);
  applyOutside(sureGame, split);
  assert.equal(sureGame.ahead, undefined);
  assert.equal(sureGame.withBook, undefined);

  const agreed = {
    home: "Medvedev, Daniil", away: "Safiullin, Roman",
    call: { home: 68, away: 32, score: "2:1" },
    scores: [{ sel: "2:0", odds: 1.4, p: 60 }, { sel: "2:1", odds: 4.5, p: 22 }],
    ahead: { sel: "2:1", ours: 30, book: 18 },
    context: { note: "" },
  };
  applyOutside(agreed, readOutside(agreed, { predix: rows, tp: [] }));
  assert.equal(agreed.ahead, undefined);
  assert.equal(agreed.withBook.sel, "2:0");

  const close = {
    home: "Roman, One", away: "Roman, Two",
    call: { home: 52, away: 48, score: "2:0" },
    scores: [{ sel: "2:0", odds: 2.4, p: 40 }, { sel: "2:1", odds: 3.4, p: 28 }],
    context: { note: "" },
  };
  applyOutside(close, readOutside(close, { predix: rows, tp: [] }));
  assert.equal(close.called.sel, "2:1");
});

test("form nudges a little and an injury moves the winner", () => {
  const call = { home: 55, away: 45, score: "2:1", scoreP: 30 };
  const scores = [
    { sel: "2:0", p: 25 }, { sel: "2:1", p: 30 },
    { sel: "1:2", p: 25 }, { sel: "0:2", p: 20 },
  ];
  const hot = shiftCall(call, scores, { homeN: 5, awayN: 5, homeWins: 5, awayWins: 0, homeRetire: false, awayRetire: false });
  assert.ok(hot.call.home > 55);
  assert.ok(hot.call.home - 55 <= 7);
  assert.equal(hot.why.includes("home form"), true);
  const out = shiftCall(call, scores, { homeOut: true, homeN: 0, awayN: 0, homeWins: 0, awayWins: 0 });
  assert.equal(out.call.side, "away");
  assert.ok(out.call.home <= 12);
  assert.equal(nameKey("Svajda, Zachary"), nameKey("Zachary Svajda"));
});

test("a tennis set score is booked as tennis, not a football score", () => {
  const row = toSelection({
    eventId: "sr:match:1", home: "A", away: "B", sport: "tn", selection: "1:2", price: 4.3,
    marketId: "199", outcomeId: "sr:correct_score:bestof:3:6",
    specifier: "variant=sr:correct_score:bestof:3",
  });
  assert.equal(row.marketId, "199");
  assert.equal(row.outcomeId, "sr:correct_score:bestof:3:6");
  assert.equal(row.specifier, "variant=sr:correct_score:bestof:3");
  assert.throws(() => toSelection({
    eventId: "sr:match:1", home: "A", away: "B", sport: "tn", selection: "2:0", price: 1.5,
  }), /tennis set score/);
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
