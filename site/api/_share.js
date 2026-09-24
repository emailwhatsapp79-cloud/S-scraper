// SportyBet share codes. No login, no stake — they issue a booking code
// that loads the slip. This POST is not the WAF-walled wapEvents call.
const SHARE = "https://www.sportybet.com/api/ng/orders/share";
const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

// vFootball 1X2.
export const OUTCOMES = {
  "1":  { marketId: "1",  outcomeId: "1" },
  "X":  { marketId: "1",  outcomeId: "2" },
  "2":  { marketId: "1",  outcomeId: "3" },
  "1X": { marketId: "10", outcomeId: "9" },
  "12": { marketId: "10", outcomeId: "10" },
  X2:   { marketId: "10", outcomeId: "11" },
};

// Real table tennis Winner is a 2-way (no draw).
export const TT_OUTCOMES = {
  "1": { marketId: "186", outcomeId: "4" },
  "2": { marketId: "186", outcomeId: "5" },
};

function isTT(leg) {
  if (leg.sport === "tt") return true;
  const lg = String(leg.league || "");
  return /setka|elite series|liga pro|tt cup|challenger series|table tennis/i.test(lg);
}

export function toSelection(leg) {
  const sel = String(leg.selection || "");
  let map = isTT(leg) ? TT_OUTCOMES[sel] : OUTCOMES[sel];
  if (!map && !isTT(leg)) {
    const m = sel.match(/^(\d+):(\d+)$/);
    if (m) {
      const h = Number(m[1]), a = Number(m[2]);
      if (h >= 0 && h <= 4 && a >= 0 && a <= 4) {
        map = { marketId: "45", outcomeId: String(274 + 2 * (a * 5 + h)) };
      }
    }
  }
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

export async function shareSelections(legs, book) {
  const football = book === "football" || (legs || []).some((l) => l.sport === "fc" || l.source === "football");
  const host = football ? "https://www.football.com" : "https://www.sportybet.com";
  const selections = legs.map(toSelection);
  const r = await fetch(`${host}/api/ng/orders/share`, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: host,
      Referer: `${host}/ng/`,
    },
    body: JSON.stringify({ selections }),
  });
  const body = await r.json().catch(() => ({}));
  const code = body?.data?.shareCode;
  if (body?.bizCode !== 10000 || !code) {
    throw new Error(body?.message || body?.innerMsg || `${football ? "Football.com" : "SportyBet"} share HTTP ${r.status}`);
  }
  const url = String(body.data.shareURL || `${host}/ng/?shareCode=${code}`)
    .replace(/^http:\/\//, "https://");
  return { shareCode: code, shareUrl: url };
}
