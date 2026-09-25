import test from "node:test";
import assert from "node:assert/strict";
import {
  normalisePhone, sessionAlive, DAY_MS, buildOrder, movedTooFar,
  fcMatchUrl, sharePageUrl, selectionId, fromUnits, deviceUuid,
} from "../site/api/_fc.js";

test("phone drops 234 and the leading zero", () => {
  assert.equal(normalisePhone("08031234567"), "8031234567");
  assert.equal(normalisePhone("+234 803 123 4567"), "8031234567");
  assert.throws(() => normalisePhone("123"), /phone/);
  assert.match(deviceUuid(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("session dies at 24 hours and not before", () => {
  const start = 1_700_000_000_000;
  const s = { cookie: "accessToken=a", loggedInAt: start, expiresAt: start + DAY_MS };
  assert.equal(sessionAlive(s, start + DAY_MS - 1), true);
  assert.equal(sessionAlive(s, start + DAY_MS), false);
  assert.equal(sessionAlive(s, start + DAY_MS + 60_000), false);
});

test("match link uses the event id, not the short game number", () => {
  const url = fcMatchUrl({
    eventId: "sr:match:200026092521951",
    home: "AST", away: "BOU", league: "England · Virtual", id: "32519",
  });
  assert.match(url, /\/ng\/m\/n\/sport\/vFootball\/England\/Virtual\/AST-vs-BOU\/sr:match:200026092521951$/);
  assert.equal(url.includes("32519"), false);
  assert.equal(sharePageUrl("V67850F0"), "https://www.football.com/ng/m?shareCode=V67850F0");
});

test("money order uses live units and a gift covers the stake", () => {
  const legs = [{
    eventId: "sr:match:1", marketId: "10", outcomeId: "9", product: "3",
    sportId: "sr:sport:202120001", price: 1.25, probability: "0.8",
  }];
  const cash = buildOrder(legs, 100, null);
  assert.equal(cash.actualPayAmount, 1_000_000);
  assert.equal(cash.orderType, 1);
  assert.equal(cash.favor, undefined);
  assert.equal(cash.ticket.selections[0].id, selectionId("3", "sr:sport:202120001", "10", "9"));
  assert.equal(cash.ticket.bets[0].selectionRefs[0].selectionIndex, 0);

  const gift = buildOrder(legs, 100, { id: "g1", amount: 150, least: 0 });
  assert.equal(gift.actualPayAmount, 0);
  assert.equal(gift.favor.favorInfo[0].giftId, "g1");
  assert.equal(gift.ticket.bets[0].stake.value, 1_000_000);

  const two = buildOrder([legs[0], { ...legs[0], eventId: "sr:match:2" }], 50, null);
  assert.equal(two.orderType, 2);
  assert.equal(two.ticket.bets[0].selectedSystems[0], 2);
  assert.equal(fromUnits(2500000), 250);
});

test("a small price drop is allowed, a real drop is not", () => {
  assert.equal(movedTooFar(1.25, 1.24), false);
  assert.equal(movedTooFar(1.25, 1.40), false);
  assert.equal(movedTooFar(1.25, 1.10), true);
});
