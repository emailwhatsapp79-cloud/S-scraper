# Lagos POST probe (Cloudflare Worker)

One-question test: is SportyBet's POST refusal about AWS IP ranges, or about
the request itself? Every server test so far has been AWS (Vercel iad1 and
cpt1). A Cloudflare Worker triggered from Nigeria runs at the Lagos edge on
Cloudflare's own IPs -- the most different thing available.

`request.cf.colo` in the response says which city it actually ran in, so the
result is self-verifying. `LOS` = Lagos.

**Cloudflare Workers run at the edge nearest whoever opens the URL.** So the
worker URL must be opened from a Nigerian connection for the test to be valid;
opening it from elsewhere runs it at that other edge and proves nothing.

## Deploy (needs a free Cloudflare account)

- Dashboard: Workers & Pages -> Create -> paste `worker.js` -> Deploy.
- Or `wrangler deploy` with the account logged in.

Then open the `*.workers.dev` URL from a phone in Nigeria and read the JSON.
