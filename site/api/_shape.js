export const WANTED = {
  "1X2": "ft",
  "Double Chance": "dc",
  "1st Half - 1X2": "ht",
};

/** Kick-off in the future, and SportyBet has not already called it live or ended. */
export function isUpcoming(status, kickoff) {
  const st = String(status || "");
  if (/^(end|H1|H2|HT|1H|2H|LIVE)/i.test(st)) return false;
  if (kickoff != null && Number(kickoff) > 0 && Number(kickoff) <= Date.now()) return false;
  return true;
}

export function leagueBucket(g) {
  const s = String(g?.league || "");
  if (/england/i.test(s)) return "England";
  if (/spain/i.test(s)) return "Spain";
  if (/italy/i.test(s)) return "Italy";
  if (/germany/i.test(s)) return "Germany";
  if (/france/i.test(s)) return "France";
  return s.split("·")[0].trim() || "Other";
}

/**
 * One club cannot play two opponents in the same minute.
 * Leftover rows lose to the fresher event.
 */
export function dropClashes(games) {
  const list = Array.isArray(games) ? games : [];
  const seen = (g) => {
    const t = g.lastSeen ? new Date(g.lastSeen).getTime() : (g.last_seen ? new Date(g.last_seen).getTime() : 0);
    return isFinite(t) ? t : 0;
  };
  const minute = (g) => Math.floor(Number(g.kickoff) / 60000);
  const slot = new Map();
  const take = (team, g) => {
    if (!team || !g.kickoff) return;
    const k = leagueBucket(g) + "|" + minute(g) + "|" + String(team).toUpperCase();
    const prev = slot.get(k);
    if (!prev) { slot.set(k, g); return; }
    if (seen(g) > seen(prev)) { slot.set(k, g); return; }
    if (seen(g) === seen(prev) && g.eventId && !prev.eventId) slot.set(k, g);
  };
  for (const g of list) {
    take(g.home, g);
    take(g.away, g);
  }
  return list.filter((g) => {
    if (!g.kickoff) return true;
    const h = slot.get(leagueBucket(g) + "|" + minute(g) + "|" + String(g.home || "").toUpperCase());
    const a = slot.get(leagueBucket(g) + "|" + minute(g) + "|" + String(g.away || "").toUpperCase());
    return h === g && a === g;
  });
}
