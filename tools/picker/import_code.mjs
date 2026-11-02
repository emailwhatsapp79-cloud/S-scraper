// Save any SportyBet booking code to Vantage for tracking, straight from the
// code itself (works even when a leg has already started and its markets are
// closed). Table tennis and tennis winners and football goal lines are
// labelled; other markets keep SportyBet's own wording.
// Run from site/ with DATABASE_URL set: node ../tools/picker/import_code.mjs CODE [stake]
const { sql } = await import(process.cwd() + "/api/_db.js");
const [code, stake = "0"] = process.argv.slice(2);
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const d = (await fetch(`https://www.sportybet.com/api/ng/orders/share/${code}`, { headers: H }).then((r) => r.json())).data;
if (!d?.outcomes?.length) { console.log("no such code", code); process.exit(1); }
const SPORT = { "sr:sport:20": "tt", "sr:sport:5": "tn", "sr:sport:1": "fb", "sr:sport:2": "bb" };
const legs = [];
for (const o of d.outcomes) {
  const m = o.markets[0], oc = m.outcomes[0], sport = SPORT[o.sport.id] || "fb";
  const total = (/total=([\d.]+)/.exec(m.specifier || "") || [])[1];
  let sel = oc.desc, label = `${m.desc}: ${oc.desc}`;
  if (String(m.id) === "186") { sel = oc.desc === "Home" ? "1" : "2"; label = `${oc.desc === "Home" ? o.homeTeamName : o.awayTeamName} to win`; }
  else if (total && /^(Over|Under)/.test(oc.desc)) {
    const id = String(m.id), half = ["68", "69", "70"].includes(id) ? "1" : "", side = ["19", "69"].includes(id) ? "H" : ["20", "70"].includes(id) ? "A" : "";
    sel = `${half}${side}${oc.desc[0]}${total}`;
  } else if (String(m.id) === "10") sel = { "Home or Draw": "1X", "Draw or Away": "X2", "Home or Away": "12" }[oc.desc] || oc.desc;
  else if (String(m.id) === "1") sel = { Home: "1", Draw: "X", Away: "2" }[oc.desc] || oc.desc;
  legs.push({ o, m, oc, sport, sel, label });
}
const combined = Math.round(legs.reduce((s, l) => s * +l.oc.odds, 1) * 100) / 100;
const id = crypto.randomUUID();
await sql`INSERT INTO slips (id, stake, combined_odds, potential, status, share_code, share_url, order_id, pay_with)
  VALUES (${id}, ${+stake}, ${combined}, ${Math.round(+stake * combined * 100) / 100}, 'open', ${code}, ${"https://www.sportybet.com/ng/?shareCode=" + code}, NULL, NULL)`;
for (let i = 0; i < legs.length; i++) {
  const { o, m, oc, sport, sel, label } = legs[i];
  await sql`INSERT INTO slip_legs (slip_id, pos, game_id, event_id, home, away, league, kickoff, selection, selection_label, price, sport, market_id, outcome_id, specifier)
    VALUES (${id}, ${i}, ${String(o.gameId || "")}, ${o.eventId}, ${o.homeTeamName}, ${o.awayTeamName}, ${o.sport?.category?.tournament?.name || ""}, ${o.estimateStartTime}, ${sel}, ${label}, ${+oc.odds}, ${sport}, ${String(m.id)}, ${String(oc.id)}, ${m.specifier || null})`;
}
console.log({ code, legs: legs.length, combined, stake: +stake });
