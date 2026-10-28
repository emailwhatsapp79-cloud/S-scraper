// Save a booked any-market slip: args code stake "eventId|market desc|outcome desc|selCode|sport" ...
const { sql } = await import(process.cwd() + "/api/_db.js");
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const [code, stake, ...specs] = process.argv.slice(2);
const niceLabel = (sel, sport, ev) => {
  if (sel === "D1" || sel === "D2") return `Draw no bet: ${sel === "D1" ? ev.homeTeamName : ev.awayTeamName}`;
  const m = sel.match(/^(1|C)?(H|A)?(O|U)([\d.]+)$/); if (!m) return sel;
  const unit = m[1] === "C" ? "corners" : sport === "bb" ? "points" : "goals";
  const who = m[2] === "H" ? ev.homeTeamName + " " : m[2] === "A" ? ev.awayTeamName + " " : "";
  return `${m[1] === "1" ? "1st half: " : ""}${who}${m[3] === "O" ? "over" : "under"} ${m[4]} ${unit}`.replace(/^./, (c) => c.toUpperCase());
};
const legs = [];
for (const a of specs) {
  const [eid, mdesc, odesc, sel, sport] = a.split("|");
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${eid}&productId=3`, { headers: H }).then((r) => r.json())).data;
  let hit = null;
  for (const m of ev.markets || []) {
    const full = m.desc + (m.specifier && !m.desc.match(/[\d.]+$/) ? " [" + m.specifier + "]" : "");
    if (m.desc !== mdesc && full !== mdesc) continue;
    const o = (m.outcomes || []).find((x) => x.desc === odesc); if (o) { hit = { m, o }; break; }
  }
  if (!hit) { console.log("MISSING", a); process.exit(1); }
  legs.push({ ev, m: hit.m, o: hit.o, sel, sport, label: niceLabel(sel, sport, ev) });
}
const combined = Math.round(legs.reduce((s, l) => s * +l.o.odds, 1) * 100) / 100;
const id = crypto.randomUUID();
await sql`INSERT INTO slips (id, stake, combined_odds, potential, status, share_code, share_url, order_id, pay_with)
  VALUES (${id}, ${+stake}, ${combined}, ${Math.round(+stake * combined * 100) / 100}, 'open', ${code}, ${"https://www.sportybet.com/ng/?shareCode=" + code}, NULL, NULL)`;
for (let i = 0; i < legs.length; i++) {
  const { ev, m, o, sel, sport, label } = legs[i];
  await sql`INSERT INTO slip_legs (slip_id, pos, game_id, event_id, home, away, league, kickoff, selection, selection_label, price, sport, market_id, outcome_id, specifier)
    VALUES (${id}, ${i}, ${String(ev.gameId)}, ${ev.eventId}, ${ev.homeTeamName}, ${ev.awayTeamName}, ${ev.sport.category.tournament.name}, ${ev.estimateStartTime}, ${sel}, ${label}, ${+o.odds}, ${sport}, ${m.id}, ${o.id}, ${m.specifier || null})`;
}
console.log({ id, legs: legs.length, combined });
