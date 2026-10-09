import test from "node:test";
import assert from "node:assert/strict";
import {
  splitName, poolOf, gamerKey, bookHome, normaliseEB, finalScore, predict, learn, pickOf, grade, MIN_N,
} from "../site/api/_eb_model.js";
import { gradeHoldout } from "../site/api/_grade.js";

test("the gamer is the name in brackets, not the team", () => {
  assert.deepEqual(splitName("Toronto Raptors (Losmi)"), { team: "Toronto Raptors", gamer: "Losmi" });
  assert.equal(gamerKey("Toronto Raptors (Losmi)", "ESportsBattle E-Basketball (format 4x5 mins, OT-3 mins)"),
    gamerKey("Detroit Pistons (Losmi)", "ESportsBattle E-Basketball (format 4x5 mins, OT-3 mins)"));
});

test("pools stay apart", () => {
  assert.equal(poolOf("eBasket NBA League"), "ebasket");
  assert.equal(poolOf("ESportsBattle E-Basketball (format 4x5 mins, OT-3 mins)"), "esb");
  assert.equal(poolOf("ESportsBattle E-Basketball European Conference (format 4x5 mins, OT-3 mins)"), "esb-eu");
});

test("reads the winner market off a SportyBet event", () => {
  const g = normaliseEB({
    gameId: "39560", eventId: "sr:match:x", estimateStartTime: 1791533400000, matchStatus: "Not start",
    homeTeamName: "Toronto Raptors (Losmi)", awayTeamName: "New Orleans Pelicans (Chime)",
    markets: [
      { id: "1", outcomes: [{ id: "1", odds: "2.95" }, { id: "2", odds: "27" }, { id: "3", odds: "1.37" }] },
      { id: "219", outcomes: [{ id: "4", desc: "Home", odds: "2.79" }, { id: "5", desc: "Away", odds: "1.35" }] },
    ],
  }, "ESportsBattle");
  assert.deepEqual(g.win, { home: 2.79, away: 1.35 });
});

test("only a finished, untied score settles", () => {
  assert.deepEqual(finalScore({ matchStatus: "Ended", setScore: "70:89" }), { home: 70, away: 89 });
  assert.equal(finalScore({ matchStatus: "Q4", setScore: "60:58" }), null);
  assert.equal(finalScore({ matchStatus: "Ended", setScore: "60:60" }), null);
});

test("with no record our % is the book's", () => {
  const b = bookHome(2.0, 2.0);
  assert.equal(b, 0.5);
  assert.ok(Math.abs(predict(0.62, { r: 0, n: 0 }, { r: 0, n: 0 }) - 0.62) < 1e-9);
});

test("a gamer who keeps beating the book drifts above it, and the swing is zero-sum", () => {
  const H = { r: 0, n: 0 }, A = { r: 0, n: 0 };
  for (let i = 0; i < 40; i++) learn(0.5, H, A, true);
  assert.ok(H.r > 0 && Math.abs(H.r + A.r) < 1e-12);
  assert.ok(predict(0.5, H, A) > 0.55);
});

test("no paper pick on thin records, small gaps or long prices", () => {
  const win = { home: 2.1, away: 1.75 };
  assert.equal(pickOf(0.6, 0.5, win, MIN_N - 1, 50), null);
  assert.equal(pickOf(0.52, 0.5, win, 50, 50), null);
  assert.equal(pickOf(0.4, 0.2, { home: 4.5, away: 1.2 }, 50, 50), null);
  assert.equal(pickOf(0.6, 0.5, win, 50, 50).side, "home");
});

test("picks that hit often but lose money are not proven", () => {
  // Backing 1.30 shots and winning 72%: high hit rate, losing return.
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ pre: 0.85, nH: 50, nA: 50, win: { home: 1.3, away: 3.5 }, res: i % 25 < 18 ? { home: 80, away: 70 } : { home: 70, away: 80 } });
  }
  const g = grade(rows);
  assert.equal(g.picks.n, 200);
  assert.ok(g.picks.hit > 0.7 && g.picks.roi < 0);
  assert.equal(g.proven, false);
});

test("table tennis holdout grades on profit, not hit rate", () => {
  // Our 70% vs the book's ~62% at 1.55: hits 60% of the time, still loses.
  const rows = [];
  for (let i = 0; i < 100; i++) {
    rows.push({ pre: 70, win: { home: 1.55, away: 2.4 }, res: i % 5 < 3 ? { home: 3, away: 1 } : { home: 1, away: 3 } });
  }
  const g = gradeHoldout(rows);
  assert.equal(g.beat.n, 100);
  assert.ok(g.beat.hit >= 0.55);
  assert.ok(g.beat.roi < 0);
  assert.equal(g.proven, false);
});

test("table tennis holdout proves a bucket that wins money clearly", () => {
  const rows = [];
  for (let i = 0; i < 200; i++) {
    rows.push({ pre: 72, win: { home: 1.6, away: 2.3 }, res: i % 10 < 8 ? { home: 3, away: 0 } : { home: 0, away: 3 } });
  }
  const g = gradeHoldout(rows);
  assert.ok(g.beat.roi > 0.2);
  assert.equal(g.proven, true);
});

test("an eBasketball leg books the winner market under eBasketball", async () => {
  const { toSelection } = await import("../site/api/_share.js");
  const row = toSelection({ sport: "eb", eventId: "sr:match:1", selection: "2", price: 1.78, home: "A (x)", away: "B (y)" });
  assert.equal(row.marketId, "219");
  assert.equal(row.outcomeId, "5");
  assert.equal(row.sportId, "sr:sport:153");
});

test("the price check reads market 219 on an eBasketball event", async () => {
  const { quote } = await import("../site/api/_fc.js");
  const ev = {
    eventId: "sr:match:75389334", sport: { id: "sr:sport:153" }, matchStatus: "Not start",
    markets: [{ id: "219", desc: "Winner (incl. overtime)", product: 3, status: 0,
      outcomes: [{ id: "4", desc: "Home", odds: "1.90", isActive: 1 }, { id: "5", desc: "Away", odds: "1.78", isActive: 1 }] }],
  };
  const q = quote(ev, "1", { sport: "eb" });
  assert.equal(q.marketId, "219");
  assert.equal(q.outcomeId, "4");
  assert.equal(q.odds, 1.9);
  assert.equal(q.sportId, "sr:sport:153");
});
