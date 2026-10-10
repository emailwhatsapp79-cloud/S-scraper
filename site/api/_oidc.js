// GitHub Actions OIDC: a workflow in this repo can ask GitHub for a short-lived
// signed token. Checking that signature against GitHub's public keys proves a
// request came from our own workflow, with no shared secret to store anywhere.
import { createPublicKey, verify } from "crypto";

const ISS = "https://token.actions.githubusercontent.com";
const REPO = "emailwhatsapp79-cloud/s-scraper";
export const AUDIENCE = "vfs-s24";

let keys = null, keysAt = 0;
async function jwks(force) {
  if (!force && keys && Date.now() - keysAt < 3600 * 1000) return keys;
  const r = await fetch(ISS + "/.well-known/jwks");
  if (!r.ok) throw new Error("jwks HTTP " + r.status);
  keys = (await r.json()).keys || [];
  keysAt = Date.now();
  return keys;
}

const b64 = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** The token's claims when it is a valid GitHub token for this repo, else null. */
export async function githubOk(req) {
  const auth = String(req.headers?.authorization || "");
  const tok = auth.replace(/^Bearer\s+/i, "");
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  let head, claims;
  try {
    head = JSON.parse(b64(parts[0]).toString());
    claims = JSON.parse(b64(parts[1]).toString());
  } catch { return null; }
  if (head.alg !== "RS256" || !head.kid) return null;
  let jwk = (await jwks()).find((k) => k.kid === head.kid);
  if (!jwk) jwk = (await jwks(true)).find((k) => k.kid === head.kid);
  if (!jwk) return null;
  const good = verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]),
    createPublicKey({ key: jwk, format: "jwk" }), b64(parts[2]));
  if (!good) return null;
  const now = Date.now() / 1000;
  if (claims.iss !== ISS || claims.aud !== AUDIENCE) return null;
  if (!(claims.exp > now) || (claims.nbf && claims.nbf > now + 60)) return null;
  if (String(claims.repository || "").toLowerCase() !== REPO) return null;
  return claims;
}
