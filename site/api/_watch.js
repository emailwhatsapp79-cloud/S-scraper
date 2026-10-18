// What to tell you about a booked leg while it is on.
// Pure: no database, no pushes. The caller sends each moment once.
//
// Table tennis and tennis already get a ping on every finished set (1–0, 1–1,
// …). This adds: the game has started; a table-tennis / tennis set swinging
// your way or against you; every football scoreline; an eBasketball lead that
// flips. It never places or cashes a bet.

const LIVE_RE = /^(H1|H2|HT|1H|2H|LIVE|set\s*\d|Playing|1st|2nd|3rd|4th|5th|Q[1-4]|OT|Overtime|Pause)/i;

export function isLiveStatus(status) {
  const s = String(status || "").trim();
  if (!s) return false;
  if (/^(end|finish|final|retir|walkover|abandon|closed|cancel|not\s*start)/i.test(s)) return false;
  return LIVE_RE.test(s);
}

// True when this leg should be checked often: it is on, or it kicks off within
// 3 minutes (and not more than 10 minutes ago, in case the status is late).
export function legIsHot(leg, now) {
  if (!leg || leg.won === "yes" || leg.won === "no") return false;
  if (isLiveStatus(leg.match_status)) return true;
  const k = Number(leg.kickoff);
  if (!isFinite(k) || k <= 0) return false;
  const t = Number(now);
  return k - t <= 3 * 60 * 1000 && t - k <= 10 * 60 * 1000;
}

function parsePair(text) {
  const m = String(text || "").trim().match(/^(\d+)\s*:\s*(\d+)$/);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

function pairs(text) {
  return String(text || "").split(/[\s,]+/).map(parsePair).filter(Boolean);
}

function lastName(s) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.includes(",") ? t.split(",")[0].trim() : (t.split(/\s+/).pop() || t);
}

function pickLabel(leg) {
  const lab = String(leg.selection_label || "").trim();
  if (lab) return lab;
  if (leg.selection === "1") return leg.home || "Home";
  if (leg.selection === "2") return leg.away || "Away";
  if (leg.selection === "X") return "Draw";
  if (leg.selection === "1X") return "Home or draw";
  if (leg.selection === "X2") return "Away or draw";
  if (leg.selection === "12") return "Home or away";
  return String(leg.selection || "your pick");
}

function dash(h, a) {
  return h + "–" + a;
}

// How the running score sits against the pick. code is stable when only the
// numbers move (20–18 and 24–16 are both "win").
export function scoreStory(selection, h, a) {
  const sel = String(selection || "");
  const line = dash(h, a);
  if (sel === "1" || sel === "2") {
    const mine = sel === "1" ? h : a;
    const theirs = sel === "1" ? a : h;
    if (mine > theirs) return { code: "win", tone: "good", title: "Winning · " + line };
    if (mine === theirs) return { code: "level", tone: "flat", title: "Level · " + line };
    return { code: "lose", tone: "bad", title: "Losing · " + line };
  }
  if (sel === "X") {
    if (h === a) return { code: "draw-on", tone: "good", title: "Draw still on · " + line };
    return { code: "draw-gone", tone: "bad", title: "Draw is gone · " + line };
  }
  if (sel === "1X" || sel === "X2") {
    const ok = sel === "1X" ? h >= a : a >= h;
    if (ok) return { code: "cover", tone: "good", title: "Still covers · " + line };
    return { code: "lose", tone: "bad", title: "Losing · " + line };
  }
  if (sel === "12") {
    if (h !== a) return { code: "cover", tone: "good", title: "Still covers · " + line };
    return { code: "need", tone: "flat", title: "Needs a winner · " + line };
  }
  return null;
}

function kindOf(tone) {
  if (tone === "good") return "yes";
  if (tone === "bad") return "no";
  return "kick";
}

function names(leg) {
  const h = lastName(leg.home);
  const a = lastName(leg.away);
  if (h && a) return h + " v " + a;
  return (leg.home || "") + " v " + (leg.away || "");
}

function body(leg, extra) {
  const bits = [(leg.home || "") + " v " + (leg.away || ""), "your pick: " + pickLabel(leg)];
  if (extra) bits.push(extra);
  return bits.filter(Boolean).join(" · ");
}

// Current set's points. Table tennis keeps them in `played`. Tennis keeps
// every set in game_score; the one still open sits after the finished sets.
function setPoints(leg, prev) {
  const setScore = prev ? leg.prev_set_score : leg.set_score;
  if (leg.sport === "tn") {
    const all = pairs(prev ? leg.prev_game_score : leg.game_score);
    const ss = parsePair(setScore);
    const done = ss ? ss[0] + ss[1] : 0;
    return all[done] || null;
  }
  if (leg.sport === "tt") return parsePair(prev ? leg.prev_played : leg.played);
  return null;
}

function setFinished(sport, h, a) {
  const hi = Math.max(h, a);
  const lo = Math.min(h, a);
  if (sport === "tn") return (hi >= 6 && hi - lo >= 2) || (hi === 7 && lo >= 5);
  return hi >= 11 && hi - lo >= 2;
}

// In the set being played: say something when a lead becomes clear (3 points
// or games), when that lead disappears, or when it turns the other way.
function insetMoment(leg, base) {
  if (leg.sport !== "tt" && leg.sport !== "tn") return null;
  if (leg.selection !== "1" && leg.selection !== "2") return null;
  const cur = setPoints(leg, false);
  if (!cur || cur[0] + cur[1] === 0) return null;
  if (setFinished(leg.sport, cur[0], cur[1])) return null;
  const sideHome = leg.selection === "1";
  const mine = sideHome ? cur[0] : cur[1];
  const theirs = sideHome ? cur[1] : cur[0];
  const st = mine > theirs ? "ahead" : mine < theirs ? "behind" : "level";
  const lead = Math.abs(mine - theirs);
  const prev = setPoints(leg, true);
  let prevSt = null;
  let prevLead = 0;
  if (prev && prev[0] + prev[1] > 0 && !setFinished(leg.sport, prev[0], prev[1])) {
    const pm = sideHome ? prev[0] : prev[1];
    const pt = sideHome ? prev[1] : prev[0];
    prevSt = pm > pt ? "ahead" : pm < pt ? "behind" : "level";
    prevLead = Math.abs(pm - pt);
  }
  const clear = st !== "level" && lead >= 3;
  const opened = clear && (!prevSt || prevSt === "level" || prevLead < 3 || prevSt !== st);
  const turned = !!(prevSt && prevSt !== "level" && prevLead >= 3 && st !== prevSt);
  const backLevel = st === "level" && prevLead >= 3 && prevSt && prevSt !== "level";
  if (!opened && !turned && !backLevel) return null;
  const tone = st === "ahead" ? "good" : st === "behind" ? "bad" : "flat";
  const word = st === "ahead" ? "Winning this set" : st === "behind" ? "Losing this set" : "This set is level";
  const ss = parsePair(leg.set_score);
  const sets = ss && ss[0] + ss[1] > 0 ? "sets " + dash(ss[0], ss[1]) : "";
  return {
    key: "inset-" + base + "-" + cur[0] + ":" + cur[1],
    kind: kindOf(tone),
    title: word + " · " + dash(cur[0], cur[1]),
    body: body(leg, sets),
  };
}

function scoreMoment(leg, base) {
  if (leg.sport === "tt" || leg.sport === "tn") return null;
  const cur = parsePair(leg.set_score);
  if (!cur || cur[0] + cur[1] === 0) return null;
  const story = scoreStory(leg.selection, cur[0], cur[1]);
  if (!story) return null;
  const prev = parsePair(leg.prev_set_score);
  if (prev && prev[0] === cur[0] && prev[1] === cur[1]) return null;
  if (leg.sport === "eb" && prev) {
    const before = scoreStory(leg.selection, prev[0], prev[1]);
    if (before && before.code === story.code) return null;
  }
  return {
    key: (leg.sport === "eb" ? "story-" : "score-") + base + "-" + cur[0] + ":" + cur[1],
    kind: kindOf(story.tone),
    title: story.title,
    body: body(leg),
  };
}

// Football (virtual or real): half-time, and every 10 minutes of the match
// clock (10', 20' ... 80'), each with how the score sits against the pick. A
// virtual match is over in a few real minutes, so a check can jump several
// marks; only the latest mark passed is sent.
export function clockMoment(leg, base) {
  if (!leg || leg.sport === "tt" || leg.sport === "tn" || leg.sport === "eb") return null;
  const status = String(leg.match_status || "");
  const sc = parsePair(leg.set_score) || [0, 0];
  const story = scoreStory(leg.selection, sc[0], sc[1]);
  const how = story ? story.title : dash(sc[0], sc[1]);
  const kind = story ? kindOf(story.tone) : "kick";
  if (/^(HT|half)/i.test(status)) {
    return { key: "ht-" + base, kind, title: "\u23f8 Half-time \u00b7 " + how, body: body(leg, "") };
  }
  if (!isLiveStatus(status)) return null;
  const m = String(leg.played || "").match(/^(\d+)/);
  if (!m) return null;
  const mark = Math.floor(Number(m[1]) / 10) * 10;
  if (mark < 10 || mark > 80) return null;
  return { key: "min-" + base + "-" + mark, kind, title: "\u23f1 " + mark + "' \u00b7 " + how, body: body(leg, "") };
}

export function legMoments(leg) {
  if (!leg || leg.won === "yes" || leg.won === "no") return [];
  const base = String(leg.slip_id) + "-" + String(leg.game_id);
  const out = [];
  if (isLiveStatus(leg.match_status)) {
    const line = [];
    if (leg.sport === "tt" || leg.sport === "tn") {
      const ss = parsePair(leg.set_score);
      if (ss && ss[0] + ss[1] > 0) line.push("sets " + dash(ss[0], ss[1]));
    } else {
      const sc = parsePair(leg.set_score);
      const story = sc && sc[0] + sc[1] > 0 ? scoreStory(leg.selection, sc[0], sc[1]) : null;
      if (story) line.push(story.title);
    }
    out.push({
      key: "start-" + base,
      kind: "kick",
      title: "Started · " + (names(leg) || "Booked game"),
      body: body(leg, line.join(" · ")),
    });
  }
  const inset = insetMoment(leg, base);
  if (inset) out.push(inset);
  const clock = clockMoment(leg, base);
  if (clock) out.push(clock);
  // The start ping already includes the score. A separate "Winning · 1–0"
  // only goes out once the game was already on and the score then changed.
  const starting = isLiveStatus(leg.match_status) && !isLiveStatus(leg.prev_status);
  const score = scoreMoment(leg, base);
  if (score && !starting) out.push(score);
  return out;
}

function lagosWhen(ms) {
  const n = Number(ms);
  if (!isFinite(n) || n <= 0) return "";
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Africa/Lagos",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(n));
  } catch {
    return "";
  }
}

// One line per booked leg for the timer. No stake, no cash-out, no booking code.
export function watchLine(leg) {
  const id = String(leg.slip_id) + "-" + String(leg.game_id);
  const live = isLiveStatus(leg.match_status);
  const ended = leg.won === "yes" || leg.won === "no";
  const pair = parsePair(leg.set_score);
  let story = "";
  if (!ended && pair && (pair[0] + pair[1] > 0) && leg.sport !== "tt" && leg.sport !== "tn") {
    const s = scoreStory(leg.selection, pair[0], pair[1]);
    if (s) story = s.title;
  }
  const pts = !ended && (leg.sport === "tt" || leg.sport === "tn") ? setPoints(leg, false) : null;
  const bits = [];
  if (ended) bits.push(leg.won === "yes" ? "Won" : "Lost");
  else if (live) bits.push("Live");
  else bits.push("Waiting");
  const who = names(leg);
  if (who && who.trim() !== "v") bits.push(who);
  bits.push("your pick: " + pickLabel(leg));
  if (pair && pair[0] + pair[1] > 0) {
    bits.push((leg.sport === "tt" || leg.sport === "tn" ? "sets " : "") + dash(pair[0], pair[1]));
  }
  if (pts && pts[0] + pts[1] > 0) bits.push("this set " + dash(pts[0], pts[1]));
  if (story) bits.push(story);
  if (!live && !ended) {
    const when = lagosWhen(leg.kickoff);
    if (when) bits.push("starts " + when);
  }
  const key = [
    leg.sport || "",
    leg.match_status || "",
    leg.set_score || "",
    leg.played || "",
    leg.game_score || "",
    story,
    leg.won || "",
  ].join("|");
  return { id, key, live: !!live, text: bits.join(" · ") };
}

// How comfortably a live TT or tennis pick is going, from the per-set scores
// ("11:8 20:18 4:7", home first, current set last). Comfortable: every set
// won by 3+ and not behind in the current one. Tight: a set won by 2 or less
// (or at deuce), a set dropped, level in sets, or a little behind now.
// Struggling: behind in sets, just lost the last set when level, or well
// behind in the current set (4+ points in TT, 2+ games in tennis).
export function struggleOf(leg) {
  if (!leg || (leg.selection !== "1" && leg.selection !== "2")) return null;
  const tt = leg.sport === "tt", tn = leg.sport === "tn";
  if (!tt && !tn) return null;
  const sets = String(leg.gameScore || "").trim().split(/\s+/)
    .map((s) => s.match(/^(\d+):(\d+)$/)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
  if (!sets.length) return null;
  const done = (a, b) => tt
    ? Math.max(a, b) >= 11 && Math.abs(a - b) >= 2
    : (Math.max(a, b) >= 6 && Math.abs(a - b) >= 2) || Math.max(a, b) === 7;
  let won = 0, lost = 0, lastLost = false, close = false, cur = null;
  const notes = [];
  sets.forEach(([h, a], i) => {
    const me = leg.selection === "1" ? h : a, op = leg.selection === "1" ? a : h;
    if (done(h, a)) {
      if (me > op) { won++; lastLost = false; if (me - op <= 2) { close = true; notes.push(`only edged set ${i + 1} ${me}-${op}`); } }
      else { lost++; lastLost = true; notes.push(`lost set ${i + 1} ${me}-${op}`); }
    } else if (i === sets.length - 1 && me + op > 0) cur = { me, op, n: i + 1 };
  });
  if (!won && !lost && !cur) return null;
  const big = tt ? 4 : 2, small = tt ? 2 : 1;
  const behindBig = cur && cur.op - cur.me >= big, behindSmall = cur && cur.op - cur.me >= small;
  if (behindSmall) notes.push(`behind ${cur.me}-${cur.op} in set ${cur.n}`);
  let level = "comfortable";
  if (lost > won || (lastLost && lost === won) || behindBig) level = "struggling";
  else if (close || lost > 0 || (won === lost && won > 0) || behindSmall) level = "tight";
  const text = notes.length ? notes.slice(-2).reverse().join(" · ")
    : `${won}-${lost} in sets` + (cur ? `, ${cur.me}-${cur.op} in set ${cur.n}` : "");
  return { level, text };
}
