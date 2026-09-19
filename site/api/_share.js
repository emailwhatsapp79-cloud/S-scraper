// SportyBet share codes. No login, no stake — they issue a booking code
// that loads the slip. This POST is not the WAF-walled wapEvents call.
const SHARE = "https://www.sportybet.com/api/ng/orders/share";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

// vFootball market/outcome ids are stable on SportyBet.
export const OUTCOMES = {
  "1":  { marketId: "1",  outcomeId: "1" },
  "X":  { marketId: "1",  outcomeId: "2" },
  "2":  { marketId: "1",  outcomeId: "3" },
  "1X": { marketId: "10", outcomeId: "9" },
  "12": { marketId: "10", outcomeId: "10" },
  X2:   { marketId: "10", outcomeId: "11" },
};

export function toSelection(leg) {
  const map = OUTCOMES[leg.selection];
  if (!map) throw new Error(`SportyBet has no slot for ${leg.selection}`);
  if (!leg.eventId) {
    throw new Error(`${leg.home} v ${leg.away} is missing an event id — refresh Matches first`);
  }
  return {
    eventId: leg.eventId,
    marketId: map.marketId,
    outcomeId: map.outcomeId,
    odds: String(leg.price),
  };
}

export async function shareSelections(legs) {
  const selections = legs.map(toSelection);
  const r = await fetch(SHARE, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://www.sportybet.com",
      Referer: "https://www.sportybet.com/ng/m/virtual/sporty-virtual/vfootball",
    },
    body: JSON.stringify({ selections }),
  });
  const body = await r.json().catch(() => ({}));
  const code = body?.data?.shareCode;
  if (body?.bizCode !== 10000 || !code) {
    throw new Error(body?.message || body?.innerMsg || `SportyBet share HTTP ${r.status}`);
  }
  const url = String(body.data.shareURL || `https://www.sportybet.com/ng/?shareCode=${code}`)
    .replace(/^http:\/\//, "https://");
  return { shareCode: code, shareUrl: url };
}
