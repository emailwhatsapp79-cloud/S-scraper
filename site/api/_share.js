// Booking codes. No stake is taken here — a code only reloads the slip.
// Football.com's own share link is /ng/m?shareCode= . The URL their API
// returns (http, extra slash) does not survive a reload of the site.
import { sharePageUrl, selectionId, SPORT_ID } from "./_fc.js";

const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36";

export const OUTCOMES = {
  "1":  { marketId: "1",  outcomeId: "1" },
  X:    { marketId: "1",  outcomeId: "2" },
  "2":  { marketId: "1",  outcomeId: "3" },
  "1X": { marketId: "10", outcomeId: "9" },
  "12": { marketId: "10", outcomeId: "10" },
  X2:   { marketId: "10", outcomeId: "11" },
};

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
  const football = leg.sport === "fc" || leg.source === "football";
  const tennis = leg.sport === "tn";
  if (!leg.eventId) {
    throw new Error(`${leg.home} v ${leg.away} is missing an event id — refresh ${football ? "Football.com" : "Matches"} first`);
  }
  let marketId = leg.marketId ? String(leg.marketId) : null;
  let outcomeId = leg.outcomeId ? String(leg.outcomeId) : null;
  if (!marketId || !outcomeId) {
    let map = (tennis || isTT(leg)) ? TT_OUTCOMES[sel] : OUTCOMES[sel];
    if (!map && !tennis && !isTT(leg)) {
      const m = sel.match(/^(\d+):(\d+)$/);
      if (m) {
        const h = Number(m[1]), a = Number(m[2]);
        if (h >= 0 && h <= 4 && a >= 0 && a <= 4) {
          map = { marketId: "45", outcomeId: String(274 + 2 * (a * 5 + h)) };
        }
      }
    }
    if (!map && tennis && /^\d+:\d+$/.test(sel)) {
      throw new Error(`${leg.home} v ${leg.away} ${sel} is a tennis set score. Refresh Tennis and tap the green score.`);
    }
    if (!map) throw new Error(`No booking slot for ${leg.selection}`);
    marketId = map.marketId;
    outcomeId = map.outcomeId;
  }
  const row = {
    eventId: String(leg.eventId),
    marketId,
    outcomeId,
    odds: String(leg.price),
  };
  if (leg.probability) row.probability = String(leg.probability);
  if (leg.specifier) row.specifier = String(leg.specifier);
  if (football && !isTT(leg)) {
    const sportId = leg.sportId || SPORT_ID;
    const product = String(leg.product || "3");
    row.sportId = sportId;
    row.id = selectionId(product, sportId, marketId, outcomeId);
  }
  return row;
}

const FOOTBALL_HEADERS = {
  Platform: "wap",
  ClientId: "wap",
  OperId: "8",
};

function shareHeaders(host, football) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    "Content-Type": "application/json;charset=UTF-8",
    Origin: host,
    Referer: `${host}/ng/m/`,
    ...(football ? FOOTBALL_HEADERS : {}),
  };
}

export async function shareSelections(legs, book) {
  const football = book === "football" || (legs || []).some((l) => l.sport === "fc" || l.source === "football");
  const host = football ? "https://www.football.com" : "https://www.sportybet.com";
  const selections = legs.map(toSelection);
  const headers = shareHeaders(host, football);
  const r = await fetch(`${host}/api/ng/orders/share`, {
    method: "POST",
    headers,
    body: JSON.stringify({ selections }),
  });
  const body = await r.json().catch(() => ({}));
  const code = body?.data?.shareCode;
  if (body?.bizCode !== 10000 || !code) {
    throw new Error(body?.message || body?.innerMsg || `${football ? "Football.com" : "SportyBet"} share HTTP ${r.status}`);
  }
  if (football) {
    const loaded = await fetch(`${host}/api/ng/orders/share/${encodeURIComponent(code)}`, { headers })
      .then((res) => res.json()).catch(() => ({}));
    const outcomes = loaded?.data?.outcomes || [];
    const exact = selections.every((sel) => outcomes.some((o) =>
      String(o.eventId || "") === String(sel.eventId) &&
      (o.markets || []).some((m) => String(m.id || "") === String(sel.marketId) &&
        (m.outcomes || []).some((x) => String(x.id || "") === String(sel.outcomeId)))));
    if (loaded?.bizCode !== 10000 || !outcomes.length || !exact) {
      throw new Error(loaded?.message || loaded?.innerMsg || `Football.com will not load ${code}`);
    }
  }
  const url = football
    ? sharePageUrl(code)
    : String(body.data.shareURL || `${host}/ng/?shareCode=${code}`).replace(/^http:\/\//, "https://");
  return { shareCode: code, shareUrl: url };
}
