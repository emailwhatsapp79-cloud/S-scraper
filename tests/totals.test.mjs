import { test } from "node:test";
import assert from "node:assert/strict";
// _slips.js opens a Neon client on import; a placeholder URL is enough, no query runs.
process.env.DATABASE_URL ||= "postgres://u:p@localhost/db";
const { dcHit, decidedTotal } = await import("../site/api/_slips.js");

test("match totals", () => {
  assert.equal(dcHit("O205.5", 110, 100), true);
  assert.equal(dcHit("O205.5", 100, 100), false);
  assert.equal(dcHit("U241.5", 120, 115), true);
  assert.equal(dcHit("U241.5", 125, 120), false);
});

test("team totals", () => {
  assert.equal(dcHit("AU4.5", 0, 4), true);
  assert.equal(dcHit("AU4.5", 0, 5), false);
  assert.equal(dcHit("HO0.5", 1, 0), true);
  assert.equal(dcHit("HO0.5", 0, 3), false);
});

test("whole-number line that lands exactly is void, and missing scores wait", () => {
  assert.equal(dcHit("U4", 2, 2), null);
  assert.equal(dcHit("O2.5", null, 1), null);
});

test("existing selections unchanged", () => {
  assert.equal(dcHit("1", 2, 1), true);
  assert.equal(dcHit("X2", 1, 1), true);
  assert.equal(dcHit("2:1", 2, 1), true);
});

test("totals settle early once the live score passes the line", () => {
  assert.equal(decidedTotal("O1.5", 1, 2), true);   // 3 goals: over 1.5 already in
  assert.equal(decidedTotal("O2.5", 1, 1), null);   // still open
  assert.equal(decidedTotal("U3.5", 2, 2), false);  // 4 goals: under 3.5 already gone
  assert.equal(decidedTotal("AU2.5", 0, 3), false);
  assert.equal(decidedTotal("HO0.5", 1, 0), true);
  assert.equal(decidedTotal("U241.5", 100, 98), null);
  assert.equal(decidedTotal("1", 2, 0), null);       // not a totals pick
});
