import test from "node:test";
import assert from "node:assert/strict";
import { toSelection } from "../site/api/_share.js";
import { fairShares, scoresFromWin, tennisCall, normaliseTennis, shiftCall, nameKey, scoreEdge, recordVerdict, applyRecord, stanceOf, parsePredix, parseTpTips, readOutside, applyOutside, isSimEvent, isWomenEvent, drawOf, splitBooked } from "../site/api/_tennis.js";
import { quote, buildOrder } from "../site/api/_fc.js";

test("the card shows the open SportyBet price, not the closed copy", () => {
  const g = normaliseTennis({
    eventId: "sr:match:9",
    gameId: "9",
    homeTeamName: "Gabriele Bosio",
    awayTeamName: "Karol Malirz",
    estimateStartTime: Date.now() + 3600000,
    matchStatus: "Not start",
    markets: [
      { id: "186", desc: "Winner", product: 1, status: 1, outcomes: [
        { id: "4", desc: "Home", odds: "1.40", isActive: 1, probability: "0.70" },
        { id: "5", desc: "Away", odds: "2.80", isActive: 1, probability: "0.30" },
      ] },
      { id: "186", desc: "Winner", product: 3, status: 0, outcomes: [
        { id: "4", desc: "Home", odds: "1.18", isActive: 1, probability: "0.81" },
        { id: "5", desc: "Away", odds: "4.25", isActive: 1, probability: "0.19" },
      ] },
      { id: "199", desc: "Correct Score", product: 1, status: 1, outcomes: [
        { id: "live", desc: "2:0", odds: "2.80", isActive: 1, probability: "0.30" },
        { id: "live2", desc: "0:2", odds: "2.85", isActive: 1, probability: "0.30" },
        { id: "live3", desc: "2:1", odds: "3.10", isActive: 1, probability: "0.20" },
        { id: "live4", desc: "1:2", odds: "3.20", isActive: 1, probability: "0.20" },
      ] },
      { id: "199", desc: "Correct Score", product: 3, status: 0, outcomes: [
        { id: "sr:correct_score:bestof:3:4", desc: "2:0", odds: "1.47", isActive: 1, probability: "0.64" },
        { id: "sr:correct_score:bestof:3:5", desc: "2:1", odds: "4.80", isActive: 1, probability: "0.18" },
        { id: "sr:correct_score:bestof:3:6", desc: "1:2", odds: "9.25", isActive: 1, probability: "0.09" },
        { id: "sr:correct_score:bestof:3:7", desc: "0:2", odds: "8.70", isActive: 1, probability: "0.09" },
      ] },
    ],
  }, "ITF M15 Telavi", "ITF");
  assert.equal(g.win.home, 1.18);
  assert.equal(g.scores.filter((s) => s.sel === "2:0").length, 1);
  assert.equal(g.scores.find((s) => s.sel === "2:0").odds, 1.47);
});

test("a simulated match is marked sim and is not a real player", () => {
  assert.equal(isSimEvent({
    homeTeamName: "Atmane, Terence (Srl)",
    awayTeamName: "Struff, Jan-Lennard (SRL)",
    sport: { category: { name: "Simulated Reality" } },
  }, "SRL Fall Invitational", "Simulated Reality"), true);
  assert.equal(isSimEvent({ homeTeamName: "Medvedev, Daniil", awayTeamName: "Safiullin, Roman" }, "ATP Beijing", "ATP"), false);
  const g = normaliseTennis({
    eventId: "sr:match:1",
    gameId: "9",
    homeTeamName: "Atmane, Terence (Srl)",
    awayTeamName: "Struff, Jan-Lennard (SRL)",
    estimateStartTime: Date.now() + 3600000,
    matchStatus: "Not start",
    markets: [],
    sport: { category: { name: "Simulated Reality" } },
  }, "SRL Fall Invitational", "Simulated Reality");
  assert.equal(g.sim, true);
  assert.match(g.tourn, /^SIM · /);
  assert.equal(isWomenEvent("WTA Beijing", "WTA"), true);
  assert.equal(isWomenEvent("ITF W15 Maanshan", "ITF"), true);
  assert.equal(isWomenEvent("ITF M15 Baku", "ITF"), false);
  assert.equal(isWomenEvent("ATP Beijing", "ATP"), false);
  assert.equal(drawOf("ATP Beijing, China Men Singles", "Medvedev, Daniil", "Safiullin, Roman"), "singles");
  assert.equal(drawOf("WTA 125K Adana, Turkiye Women Doubles", "Aksu A / Mert A", "Other / Pair"), "doubles");
  assert.equal(drawOf("ITF M15 Baku", "One, A", "Two, B"), "singles");
  assert.equal(drawOf("ITF W15 Maanshan Doubles", "A / B", "C / D"), "doubles");
});

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
  const closedLive = quote({
    eventId: "sr:match:2",
    matchStatus: "Not start",
    sport: { id: "sr:sport:5" },
    markets: [
      { id: "199", desc: "Correct Score", product: 1, status: 1, lastOddsChangeTime: 9,
        outcomes: [{ id: "sr:correct_score:bestof:3:4", desc: "2:0", odds: "2.80", isActive: 1 }] },
      { id: "199", desc: "Correct Score", product: 3, status: 0, specifier: "",
        outcomes: [{ id: "sr:correct_score:bestof:3:4", desc: "2:0", odds: "1.47", isActive: 1 }] },
    ],
  }, "2:0");
  assert.equal(closedLive.odds, 1.47);
  assert.equal(closedLive.product, "3");
  assert.equal(closedLive.specifier, "");
  const order = buildOrder([{
    eventId: q.eventId, marketId: q.marketId, outcomeId: q.outcomeId,
    sportId: q.sportId, specifier: q.specifier, product: "3", price: q.odds,
  }], 100, null);
  assert.equal(order.ticket.selections[0].specifier, "variant=sr:correct_score:bestof:3");
  assert.match(order.ticket.selections[0].id, /199\/sr:correct_score:bestof:3:7\?variant=sr:correct_score:bestof:3$/);
  assert.equal(order.ticket.selections[0].sportId, "sr:sport:5");
  const mixed = buildOrder([
    { eventId: "sr:match:1", marketId: "1", outcomeId: "1", sportId: "sr:sport:202120001", product: "3", price: 1.4, sport: "fb" },
    { eventId: q.eventId, marketId: q.marketId, outcomeId: q.outcomeId, sportId: q.sportId, specifier: q.specifier, product: "3", price: q.odds, sport: "tn" },
  ], 100, null, "XNWD12");
  assert.equal(mixed.ticket.selections[0].sportId, "sr:sport:202120001");
  assert.equal(mixed.ticket.selections[1].sportId, "sr:sport:5");
  assert.equal(mixed.loadingShareCode, "XNWD12");
  assert.equal(mixed.ticket.selections[1].betPosition, 1);

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
  assert.equal(game.winOpen, true);
  assert.equal(game.scoresOpen, true);
});

test("booked tennis splits into winners and correct score", () => {
  const got = splitBooked([
    { selection: "1", home: "A", away: "B", won: "yes", price: 1.31 },
    { selection: "2", home: "C", away: "D", won: "no", price: 1.4 },
    { selection: "1", home: "E", away: "F", won: null, price: 1.5 },
    { selection: "2:0", home: "A", away: "B", won: "yes", price: 1.8, set_score: "2:0" },
    { selection: "0:2", home: "C", away: "D", won: "no", price: 1.9, set_score: "2:1" },
  ]);
  assert.equal(got.winners.hits, 1);
  assert.equal(got.winners.n, 2);
  assert.equal(got.winners.open, 1);
  assert.equal(got.scores.hits, 1);
  assert.equal(got.scores.n, 2);
  assert.equal(got.scores.rows[0].selection, "2:0");
});

test("a suspended tennis price is shown and cannot be booked", () => {
  const game = normaliseTennis({
    eventId: "sr:match:9", gameId: "9", matchStatus: "Not start",
    estimateStartTime: Date.now() + 3600000,
    homeTeamName: "Zverev, Alexander", awayTeamName: "Norrie, Cameron",
    markets: [
      { id: "186", desc: "Winner", product: 3, status: 1, outcomes: [
        { id: "4", desc: "Home", odds: "1.11", isActive: 1 },
        { id: "5", desc: "Away", odds: "6.40", isActive: 1 },
      ] },
    ],
  }, "ATP Beijing, China Men Singles");
  assert.equal(game.suspended, true);
  assert.equal(game.winOpen, false);
  assert.equal(game.win.home, 1.11);
  assert.equal(game.selectionRefs["1"], undefined);

  const quoted = quote({
    eventId: "sr:match:9",
    matchStatus: "Not start",
    sport: { id: "sr:sport:5" },
    markets: [
      { id: "186", desc: "Winner", product: 3, status: 1, lastOddsChangeTime: 9, outcomes: [
        { id: "4", desc: "Home", odds: "1.11", isActive: 1 },
      ] },
      { id: "186", desc: "Winner", product: 3, status: 0, lastOddsChangeTime: 2, outcomes: [
        { id: "4", desc: "Home", odds: "1.31", isActive: 1 },
        { id: "5", desc: "Away", odds: "3.40", isActive: 1 },
      ] },
    ],
  }, "1", { outcomeId: "4", sport: "tn" });
  assert.equal(quoted.odds, 1.31);
  assert.equal(quoted.sportId, "sr:sport:5");
  assert.equal(quote({
    eventId: "sr:match:9",
    sport: { id: "sr:sport:5" },
    markets: [
      { id: "186", desc: "Winner", product: 3, status: 1, outcomes: [
        { id: "4", desc: "Home", odds: "1.11", isActive: 1 },
      ] },
    ],
  }, "1", { outcomeId: "4", sport: "tn" }), null);
});
