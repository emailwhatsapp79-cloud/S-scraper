#!/usr/bin/env bash
# Fetch finished table tennis matches from scores24 and hand them to the app.
# scores24 blocks Vercel's servers but not GitHub's, so the fetch runs here and
# the app takes the rows over /api/poll?s24push=1, proven by GitHub's own
# signed token (needs `permissions: id-token: write`). No secret is stored.
#   s24-push.sh DAYS PAGES   — DAYS back from now, up to PAGES x 50 per league
set -uo pipefail
DAYS=${1:-1}; PAGES=${2:-1}
APP="https://vfootball-screener.vercel.app/api/poll?s24push=1"
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
F=$(date -u -d "-$DAYS day" +%Y-%m-%d); T=$(date -u -d '+1 day' +%Y-%m-%d)
for slug in tt-elite-series-1 czech-liga-pro-1 international-tt-cup setka-cup-0 challenger-series-tt; do
  after=""
  for ((p = 0; p < PAGES; p++)); do
    url="https://scores24.live/rapi/leagues/table-tennis/$slug/matches?lang=en&first=50&status=ended&date_between%5B%5D=$F&date_between%5B%5D=$T&with_statistics=false&audience=en"
    [ -n "$after" ] && url="$url&after=$after"
    if ! curl -fsS --max-time 20 -o page.json -H "User-Agent: $UA" -H "Accept: application/json" \
         -H "Referer: https://scores24.live/en/table-tennis" "$url"; then
      echo "$slug: fetch failed"; break
    fi
    n=$(jq '.data.edges | length' page.json 2>/dev/null || echo 0)
    [ "$n" -gt 0 ] || break
    jq -c --arg s "$slug" '{pages: [{slug: $s, edges: .data.edges}]}' page.json > body.json
    tok=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
      "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=vfs-s24" | jq -r .value)
    echo "$slug p$p ($n): $(curl -sS --max-time 55 -X POST -H "Authorization: Bearer $tok" \
      -H "Content-Type: application/json" --data-binary @body.json "$APP")"
    [ "$(jq -r '.data.pageInfo.hasNextPage' page.json)" = "true" ] || break
    after=$(jq -r '.data.pageInfo.endCursor // empty' page.json)
    [ -n "$after" ] || break
  done
done
exit 0
