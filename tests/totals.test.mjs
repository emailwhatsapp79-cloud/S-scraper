import { test } from "node:test";
import assert from "node:assert/strict";
// _slips.js opens a Neon client on import; a placeholder URL is enough, no query runs.
process.env.DATABASE_URL ||= "postgres://u:p@localhost/db";
const { dcHit } = await import("../site/api/_slips.js");

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
