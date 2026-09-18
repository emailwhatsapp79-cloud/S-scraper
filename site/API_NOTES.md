# SportyBet vFootball API — what works from a server

Findings are from live probes, not documentation. Sport id is
`sr:sport:202120001` ("vFootball", the 5 virtual leagues).

## Reachable server-side (plain GET, browser User-Agent required)

A request without a browser `User-Agent` gets a CloudFront `403` before it
reaches the app. With one, these answer `bizCode: 10000`:

| Endpoint | Returns |
|---|---|
| `factsCenter/sportList` | every sport, with vFootball's 5 categories and their event counts |
| `factsCenter/marketGroups?sportId=…` | market group ids |
| `factsCenter/configurableCustomEvents?sportId=…&marketId=1,10,60` | ~10 games, `matchStatus: "Not start"` |
| `factsCenter/configurableLiveOrPrematchEvents?sportId=…&marketId=1,10,60` | ~38 games, `matchStatus: H1`/`H2` (already running) |

`marketId=1,10,60` is the whole screen in one call — market `1` is `1X2`,
`10` is `Double Chance`, `60` is `1st Half - 1X2`. No per-game detail
request is needed. Events carry `gameId` (the number shown on the site),
`homeTeamName`, `awayTeamName`, `estimateStartTime` and `matchStatus`.

## Not reachable server-side

- **Any POST** returns `bizCode: 19003 Forbidden`, including POSTs to
  endpoints whose GET works. `factsCenter/wapEvents` — the one the site uses
  when a tournament is selected, and the only one seen returning the full
  several-hundred-game card — is POST-only, so it is out of reach.
- **Cross-origin browser calls.** No `Access-Control-Allow-Origin` header is
  sent on any response, so a page on another domain cannot call these either.

Together these mean a server or a third-party page can read the near-term
card but not the full multi-day one. Only code running on sportybet.com can.

## The POST block is not geographic

Tested from two continents with identical results:

| Server region | Outbound IP | GET | POST |
|---|---|---|---|
| `iad1` Virginia, USA | 54.198.213.188 | works | Forbidden |
| `cpt1` Cape Town, South Africa | 13.244.239.202 | works | Forbidden |

Moving the host closer to the user changes nothing, so the refusal is not
about where the request comes from geographically. `/api/diag` runs these
checks live and reports the server's region and outbound IP next to the
visitor's, which also makes clear that the request to SportyBet is issued
by the host and never by the visitor's device.

The site stays on `cpt1` anyway: it is the closest region to Nigeria, so
pages load faster there even though the database is still in Ohio.

## Unverified

Whether the GET feeds return the full day's card at the start of a day
rather than ~10. Probed late in the evening, when the site itself showed
"Today games (38)" against "All vFootball (424)". Re-probe after midnight
before building on either answer.
