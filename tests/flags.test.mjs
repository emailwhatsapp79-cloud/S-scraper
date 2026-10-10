import test from "node:test";
import assert from "node:assert/strict";
import { legFlags } from "../site/api/_flags.js";

test("the cashed-out game: 1.11 favourite loses set 1 7-11, scrapes set 2 12-10", () => {
  const f = legFlags({ sport: "tt", selection: "1", price: 1.11, set_score: "1:1", game_score: "7:11 12:10", played: "3:3" });
  assert.equal(f.level, "danger");
  assert.ok(f.reasons.some((r) => /lost set 1 7–11/.test(r)));
  assert.ok(f.reasons.some((r) => /edged set 2 12–10/.test(r)));
});

test("live odds drifting from 1.11 to 2.10 alone is danger", () => {
  const f = legFlags({ sport: "tt", selection: "2", price: 1.11, live_price: 2.1, set_score: "0:0", played: "5:6" });
  assert.equal(f.level, "danger");
});

test("a comfortable favourite raises nothing", () => {
  const f = legFlags({ sport: "tt", selection: "1", price: 1.2, live_price: 1.05, set_score: "2:0", game_score: "11:5 11:6", played: "4:2" });
  assert.equal(f.level, "none");
});

test("tennis: favourite loses a set", () => {
  const f = legFlags({ sport: "tn", selection: "1", price: 1.3, set_score: "0:1", game_score: "4:6 1:3" });
  assert.equal(f.level, "danger");
});

test("settled legs and unknown selections raise nothing", () => {
  assert.equal(legFlags({ sport: "tt", selection: "1", price: 1.1, won: "no", set_score: "0:3" }).level, "none");
  assert.equal(legFlags({ sport: "tt", selection: "X", price: 1.1 }).level, "none");
});
