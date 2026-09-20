import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import { sql } from "./_db.js";
import { seal, open } from "./_crypto.js";
import { ensure } from "./_vault.js";

async function put(k, data) {
  await ensure();
  const packed = seal(data);
  await sql`
    INSERT INTO vault (k, v, updated) VALUES (${k}, ${packed}, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()`;
}

async function get(k) {
  await ensure();
  const rows = await sql`SELECT v FROM vault WHERE k = ${k}`;
  if (!rows[0]) return null;
  try { return open(rows[0].v); } catch { return null; }
}

function rpOf(req) {
  const host = String(req.headers.host || "").split(":")[0];
  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim();
  const origin = proto + "://" + (req.headers.host || host);
  return { rpID: host, origin };
}

function b64(u8) {
  return Buffer.from(u8).toString("base64url");
}
function fromB64(s) {
  return new Uint8Array(Buffer.from(String(s || ""), "base64url"));
}

export async function hasBio() {
  const c = await get("bio");
  return !!(c && c.id && c.publicKey);
}

export async function beginRegister(req) {
  const { rpID } = rpOf(req);
  const existing = await get("bio");
  const options = await generateRegistrationOptions({
    rpName: "Vantage",
    rpID,
    userName: "owner",
    userDisplayName: "Vantage",
    attestationType: "none",
    authenticatorSelection: {
      authenticatorAttachment: "platform",
      userVerification: "required",
      residentKey: "preferred",
    },
    excludeCredentials: existing?.id ? [{ id: existing.id }] : [],
  });
  await put("bio_chal", { challenge: options.challenge, kind: "reg", exp: Date.now() + 120000 });
  return options;
}

export async function finishRegister(req, cred) {
  const { rpID, origin } = rpOf(req);
  const chal = await get("bio_chal");
  if (!chal || chal.kind !== "reg" || chal.exp < Date.now()) throw new Error("Fingerprint prompt expired");
  const verified = await verifyRegistrationResponse({
    response: cred,
    expectedChallenge: chal.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!verified.verified || !verified.registrationInfo?.credential) {
    throw new Error("Fingerprint was not saved");
  }
  const c = verified.registrationInfo.credential;
  await put("bio", {
    id: c.id,
    publicKey: b64(c.publicKey),
    counter: c.counter || 0,
    transports: c.transports || cred?.response?.transports || [],
  });
  await put("bio_chal", { challenge: "", kind: "", exp: 0 });
  return true;
}

export async function beginAuth(req) {
  const { rpID } = rpOf(req);
  const existing = await get("bio");
  if (!existing?.id) throw new Error("No fingerprint on this phone yet");
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: "required",
    allowCredentials: [{ id: existing.id, transports: existing.transports || ["internal"] }],
  });
  await put("bio_chal", { challenge: options.challenge, kind: "auth", exp: Date.now() + 120000 });
  return options;
}

export async function finishAuth(req, cred) {
  const { rpID, origin } = rpOf(req);
  const chal = await get("bio_chal");
  const existing = await get("bio");
  if (!chal || chal.kind !== "auth" || chal.exp < Date.now()) throw new Error("Fingerprint prompt expired");
  if (!existing?.id) throw new Error("No fingerprint on this phone yet");
  const verified = await verifyAuthenticationResponse({
    response: cred,
    expectedChallenge: chal.challenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: existing.id,
      publicKey: fromB64(existing.publicKey),
      counter: existing.counter || 0,
      transports: existing.transports,
    },
    requireUserVerification: true,
  });
  if (!verified.verified) throw new Error("Fingerprint did not match");
  const next = verified.authenticationInfo?.newCounter;
  if (typeof next === "number") {
    await put("bio", { ...existing, counter: next });
  }
  await put("bio_chal", { challenge: "", kind: "", exp: 0 });
  return true;
}
