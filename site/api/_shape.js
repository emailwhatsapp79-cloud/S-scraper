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
