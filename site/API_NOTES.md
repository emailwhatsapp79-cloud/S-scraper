# SportyBet vFootball API — what works from a server

Findings are from live probes, not documentation. Sport id is
`sr:sport:202120001` ("vFootball", the 5 virtual leagues).

## The remaining-day card is a GET

`GET factsCenter/pcUpcomingEvents` with `option=2` on each league returns
the rest of today's vFootball card. Probed 19 Sep 2026 ~08:00 WAT from a
server: 442 upcoming games, every one carrying markets `1` (1X2), `10`
(Double Chance) and `60` (1st Half - 1X2). No WAF token. No userscript.

| Param | Value |
|---|---|
| `sportId` | `sr:sport:202120001` |
| `tournamentId` | `sv:league:1` … `sv:league:5` (one request each) |
| `marketId` | `1,10,60` |
| `option` | **`2`** — this is the whole league, not the highlight strip |
| `timeline` | `168` |
| `pageSize` | `100` |
| `pageNum` | `1` |

`option=1` is the trap. It answers `totalNum: 90` for a league and then
only sends 10 events. The WAP highlight feed (`wapConfigurableUpcomingEvents`)
is the same 10-game window. That is what the site was reading, which is
why FIND looked empty next to "All vFootball (424)".

Without a `tournamentId`, `option=2` still caps around 100 events. Five
parallel league calls is the full card. A browser `User-Agent` is required
or CloudFront 403s before the app.

`sportList` eventSize is the same universe: ~490 = remaining upcoming +
whatever is already live. Live games cannot be backed, so they are not
shown. The 442 is the whole backable card at that hour.

## Still true, no longer in the way

- **Any POST** returns `bizCode: 19003 Forbidden`. `wapEvents` is POST-only
  and protected by AWS WAF's JavaScript token (`aws-waf-token`). A server
  cannot mint that token. Tested from Virginia, Cape Town, and Cloudflare
  edges. We do not need this route anymore.
- **Cross-origin browser calls.** No `Access-Control-Allow-Origin`, so a
  page on another domain cannot call SportyBet directly. The screener page
  calls our server; our server calls SportyBet.

## Other reachable GETs

| Endpoint | Returns |
|---|---|
| `factsCenter/sportList` | every sport, vFootball's 5 categories and event counts |
| `factsCenter/event?eventId=` | one game, including the three screen markets |
| `factsCenter/configurableLiveOrPrematchEvents` | already-running games |

`/api/diag` still runs the GET-vs-POST check. `/api/poll` is the daily
pre-warm of the card.
