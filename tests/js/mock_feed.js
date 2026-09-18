/* A payload shaped the way these feeds normally look: tournaments -> events
   -> markets -> outcomes, odds as strings. Numbers are the real 21:54 card. */
function market(desc, outcomes) {
  return { id: desc, desc, outcomes: outcomes.map(([d, o]) => ({ desc: d, odds: String(o) })) };
}
function event(id, home, away, ft, dc, ht) {
  const markets = [
    market("1X2", [["Home", ft[0]], ["Draw", ft[1]], ["Away", ft[2]]]),
    market("Over/Under", [["Over", 1.57], ["Under", 2.49]]),
  ];
  if (dc) markets.push(market("Double Chance",
    [["Home or Draw", dc[0]], ["Home or Away", dc[1]], ["Draw or Away", dc[2]]]));
  if (ht) markets.push(market("1st Half - 1X2", [["Home", ht[0]], ["Draw", ht[1]], ["Away", ht[2]]]));
  return {
    eventId: id, homeTeamName: home, awayTeamName: away,
    estimateStartTime: 1758232440000, tournamentName: "England - Virtual", markets,
  };
}
module.exports = {
  page(events) { return { bizCode: 10000, data: { totalNum: events.length, tournaments: [{ name: "England - Virtual", events }] } }; },
  event,
  card: [
    event("52350", "AST", "BRE", [2.74, 4.25, 2.32]),
    event("52354", "BHA", "BOU", [2.69, 3.60, 2.63]),
    event("52355", "CRY", "NFO", [1.84, 4.35, 3.88], [1.29, 1.25, 1.99], [2.80, 2.92, 3.02]),
    event("52352", "FUL", "CHE", [2.55, 3.94, 2.60]),
  ],
};
