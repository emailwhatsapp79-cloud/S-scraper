import test from "node:test";
import assert from "node:assert/strict";
import { isLiveStatus, legIsHot, legMoments, scoreStory, watchLine } from "../site/api/_watch.js";

const NOW = Date.parse("2026-10-11T12:00:00Z");

function leg(over) {
  return {
    slip_id: "s1", game_id: "g1", sport: "tt", selection: "1",
    selection_label: "Kowalski", home: "Kowalski, Jan", away: "Novak, Petr",
    match_status: "set 1", set_score: "0:0", played: "0:0", won: null,
    ...over,
  };
}

test("a game that has not started is not live", () => {
  assert.equal(isLiveStatus("Not start"), false);
  assert.equal(isLiveStatus(""), false);
  assert.equal(isLiveStatus("Ended"), false);
  assert.equal(isLiveStatus("set 1"), true);
  assert.equal(isLiveStatus("1st set"), true);
  assert.equal(isLiveStatus("Q2"), true);
  assert.equal(isLiveStatus("H1"), true);
  assert.equal(isLiveStatus("Playing"), true);
});

test("hot only around kickoff or while the game is on", () => {
  assert.equal(legIsHot(leg({ match_status: "Not start", kickoff: NOW + 2 * 60 * 1000 }), NOW), true);
  assert.equal(legIsHot(leg({ match_status: "Not start", kickoff: NOW + 20 * 60 * 1000 }), NOW), false);
  assert.equal(legIsHot(leg({ match_status: "set 2", kickoff: NOW - 30 * 60 * 1000 }), NOW), true);
  assert.equal(legIsHot(leg({ won: "yes", match_status: "Ended" }), NOW), false);
});

test("started ping once the booked game is on, for any sport", () => {
  const tt = legMoments(leg({}));
  assert.equal(tt[0].key, "start-s1-g1");
  assert.match(tt[0].title, /Started · Kowalski v Novak/);
  assert.match(tt[0].body, /your pick: Kowalski/);

  const ball = legMoments(leg({
    sport: "fb", match_status: "H1", selection: "1X", selection_label: "Home or draw",
    set_score: "0:0",
  }));
  assert.equal(ball.length, 1);
  assert.match(ball[0].title, /^Started/);
});

test("table tennis: say when the set swings, not on every point", () => {
  assert.equal(legMoments(leg({ played: "2:0", prev_played: "1:0" })).some((m) => m.key.startsWith("inset")), false);

  const up = legMoments(leg({ played: "4:1", prev_played: "2:0" }));
  const win = up.find((m) => m.key.startsWith("inset"));
  assert.ok(win);
  assert.match(win.title, /Winning this set · 4–1/);
  assert.equal(win.kind, "yes");

  assert.equal(legMoments(leg({ played: "7:2", prev_played: "5:1" })).some((m) => m.key.startsWith("inset")), false);

  const level = legMoments(leg({ played: "7:7", prev_played: "7:3" }));
  assert.match(level.find((m) => m.key.startsWith("inset")).title, /This set is level · 7–7/);

  const down = legMoments(leg({ played: "7:10", prev_played: "7:7", set_score: "0:0" }));
  const loss = down.find((m) => m.key.startsWith("inset"));
  assert.match(loss.title, /Losing this set · 7–10/);
  assert.equal(loss.kind, "no");
});

test("a finished table-tennis set is left to the set-score ping", () => {
  const done = legMoments(leg({ played: "11:6", prev_played: "10:6", set_score: "1:0" }));
  assert.equal(done.some((m) => m.key.startsWith("inset")), false);
  assert.equal(done.some((m) => m.key.startsWith("score-")), false);
});

test("football and vFootball: every new score, and whether the pick is alive", () => {
  const goal = legMoments(leg({
    sport: "fb", match_status: "H1", prev_status: "H1", selection: "1", selection_label: "Arsenal",
    home: "Arsenal", away: "Chelsea", set_score: "1:0", prev_set_score: "0:0",
  }));
  const score = goal.find((m) => m.key.startsWith("score-"));
  assert.match(score.title, /Winning · 1–0/);

  const firstLook = legMoments(leg({
    sport: "fb", match_status: "H1", prev_status: "Not start", selection: "1", selection_label: "Arsenal",
    home: "Arsenal", away: "Chelsea", set_score: "1:0", prev_set_score: "0:0",
  }));
  assert.equal(firstLook.some((m) => m.key.startsWith("score-")), false);
  assert.match(firstLook[0].body, /Winning · 1–0/);

  assert.equal(legMoments(leg({
    sport: "fb", match_status: "H1", prev_status: "H1", selection: "1", set_score: "1:0", prev_set_score: "1:0",
    home: "Arsenal", away: "Chelsea",
  })).some((m) => m.key.startsWith("score-")), false);

  const dc = legMoments(leg({
    sport: "fb", match_status: "H2", prev_status: "H2", selection: "1X", selection_label: "Home or draw",
    home: "Arsenal", away: "Chelsea", set_score: "0:1", prev_set_score: "0:0",
  })).find((m) => m.key.startsWith("score-"));
  assert.match(dc.title, /Losing · 0–1/);

  assert.match(scoreStory("X", 1, 0).title, /Draw is gone/);
  assert.equal(legMoments(leg({
    sport: "fb", match_status: "H1", selection: "12", selection_label: "Home or away",
    home: "Arsenal", away: "Chelsea", set_score: "0:0", prev_set_score: null,
  })).some((m) => m.key.startsWith("score-")), false);
});

test("eBasketball: ping when the lead flips, not on every basket", () => {
  const same = legMoments(leg({
    sport: "eb", match_status: "Q2", prev_status: "Q2", selection: "2", selection_label: "GamerB",
    home: "Team A", away: "Team B", set_score: "22:30", prev_set_score: "18:24",
  }));
  assert.equal(same.some((m) => m.key.startsWith("story-")), false);

  const flip = legMoments(leg({
    sport: "eb", match_status: "Q3", prev_status: "Q3", selection: "2", selection_label: "GamerB",
    home: "Team A", away: "Team B", set_score: "40:36", prev_set_score: "34:36",
  })).find((m) => m.key.startsWith("story-"));
  assert.match(flip.title, /Losing · 40–36/);
});

test("a settled leg says nothing", () => {
  assert.deepEqual(legMoments(leg({ won: "no", set_score: "0:3", played: "4:11" })), []);
});

test("the timer line names the game and the pick, never the stake", () => {
  const waiting = watchLine(leg({
    match_status: "Not start", kickoff: Date.parse("2026-10-11T10:40:00Z"),
  }));
  assert.match(waiting.text, /Waiting · Kowalski v Novak · your pick: Kowalski/);
  assert.match(waiting.text, /starts /);
  assert.equal(waiting.live, false);

  const live = watchLine(leg({ set_score: "1:0", played: "3:2" }));
  assert.match(live.text, /Live · Kowalski v Novak/);
  assert.match(live.text, /sets 1–0/);
  assert.match(live.text, /this set 3–2/);
  assert.equal(JSON.stringify(live).includes("stake"), false);
});
