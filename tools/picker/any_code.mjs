// Booking code for any SportyBet market. Args: "eventId|market desc (exact)|outcome desc" ...
const { shareSelections } = await import(process.cwd() + "/api/_share.js");
const H = { "User-Agent": "Mozilla/5.0 (Linux; Android 13) Chrome/120 Mobile Safari/537.36", Accept: "application/json", Origin: "https://www.sportybet.com", Referer: "https://www.sportybet.com/ng/m/" };
const legs = [];
for (const a of process.argv.slice(2)) {
  // Some TT event ids contain "|", so the market and outcome are the last two parts.
  const parts = a.split("|"), odesc = parts.pop(), mdesc = parts.pop(), eid = parts.join("|");
  const ev = (await fetch(`https://www.sportybet.com/api/ng/factsCenter/event?eventId=${encodeURIComponent(eid)}&productId=3`, { headers: H }).then((r) => r.json())).data;
  let hit = null;
  for (const m of ev.markets || []) {
    const full = m.desc + (m.specifier && !m.desc.match(/[\d.]+$/) ? " [" + m.specifier + "]" : "");
    if (m.desc !== mdesc && full !== mdesc) continue;
    const o = (m.outcomes || []).find((x) => x.desc === odesc);
    if (o) { hit = { m, o }; break; }
  }
  if (!hit) { console.log("MISSING", a); continue; }
  legs.push({ eventId: eid, marketId: hit.m.id, outcomeId: hit.o.id, specifier: hit.m.specifier, price: hit.o.odds, sportId: ev.sport.id, home: ev.homeTeamName, away: ev.awayTeamName, selection: odesc });
  console.log("OK", new Date(ev.estimateStartTime + 3600e3).toISOString().slice(11, 16), ev.homeTeamName, "v", ev.awayTeamName, "|", mdesc, odesc, "@" + hit.o.odds, hit.o.isActive ? "" : "(INACTIVE)");
}
const total = legs.reduce((s, l) => s * +l.price, 1);
const r = await shareSelections(legs, "sporty");
console.log({ legs: legs.length, totalOdds: total.toFixed(2), ...r });
