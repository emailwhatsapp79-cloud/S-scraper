import test from "node:test";
import assert from "node:assert/strict";
// The modules open a (lazy) database client on import; nothing here queries it.
process.env.DATABASE_URL ||= "postgres://user:pass@localhost/test";
const { tnKey, gamesShare, learnTennis, statsTennis } = await import("../site/api/_tn_model.js");
const { rowFromResult } = await import("../site/api/_tn_hist.js");

const blank = () => ({ elo: 1500, n: 0, w: 0, last: 0, r: [], g: [] });

test("player keys match across name orders and accents", () => {
  assert.equal(tnKey("Medvedev, Daniil"), tnKey("Daniil Medvedev"));
  assert.equal(tnKey("Muñoz, José"), tnKey("Jose Munoz"));
});

test("games share reads the set scores from either side", () => {
  assert.equal(gamesShare("6:4 6:2", true), 12 / 18);
  assert.equal(gamesShare("6:4 6:2", false), 6 / 18);
  assert.equal(gamesShare("", true), 0.5);
});

test("no stats until both players have 5 matches; the winner's side rises", () => {
  const H = blank(), A = blank();
  for (let i = 0; i < 4; i++) learnTennis(H, A, true, "6:3 6:3", 1000 + i);
  assert.equal(statsTennis(H, A, { n: 4, hw: 4 }, 2000), null);
  learnTennis(H, A, true, "6:3 6:3", 1010);
  const s = statsTennis(H, A, { n: 5, hw: 5 }, 2000);
  assert.ok(s > 0.5, "home has won every meeting");
  assert.equal(H.n, 5); assert.equal(H.w, 5); assert.equal(A.w, 0);
  assert.ok(H.elo > 1500 && A.elo < 1500);
  assert.equal(H.r.length, 5); assert.ok(H.g.length <= 10);
});

test("doubles and unfinished results are not history", () => {
  const ev = { gameId: "1", eventId: "sr:match:1", homeTeamName: "A, B", awayTeamName: "C, D", matchStatus: "Ended", setScore: "2:0", gameScore: ["6:1", "6:2"], estimateStartTime: 5 };
  assert.ok(rowFromResult(ev, "ITF M15 Men Singles"));
  assert.equal(rowFromResult(ev, "ATP Shanghai, China Men Doubles"), null);
  assert.equal(rowFromResult({ ...ev, homeTeamName: "A / B" }, "x"), null);
  assert.equal(rowFromResult({ ...ev, matchStatus: "2nd set" }, "x"), null);
});
