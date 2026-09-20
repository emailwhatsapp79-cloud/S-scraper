// Personal PIN + fingerprint gate. Cookie lasts 30 minutes. Override PIN with env GATE_PIN.
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cors } from "./_db.js";
import { loadPinHash } from "./_vault.js";

const SALT = "vfs-gate-v1";
const PIN_HASH = "a1130bfe4270bc67bed0b71f0ae687df544ee38a5b342a468b15549612e9629f";
const SECRET = process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";
export const TTL_MS = 30 * 60 * 1000;
const COOKIE = "vfs_gate";

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

export function hashPin(pin) {
  return sha(SALT + String(pin || "").trim());
}

function eqHex(a, b) {
  try {
    const x = Buffer.from(String(a), "hex");
    const y = Buffer.from(String(b), "hex");
    return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

export async function pinOk(pin) {
  const got = hashPin(pin);
  let stored = null;
  try { stored = await loadPinHash(); } catch { stored = null; }
  if (stored) return eqHex(got, stored);
  const env = process.env.GATE_PIN;
  return eqHex(got, env ? hashPin(env) : PIN_HASH);
}

function sign(exp) {
  return createHmac("sha256", SECRET).update(String(exp)).digest("hex");
}

export function readGate(req) {
  const raw = req.headers.cookie || "";
  const hit = raw.split(";").map((s) => s.trim()).find((s) => s.startsWith(COOKIE + "="));
  if (!hit) return { open: false, remainingMs: 0 };
  const val = decodeURIComponent(hit.slice(COOKIE.length + 1));
  const dot = val.indexOf(".");
  if (dot < 0) return { open: false, remainingMs: 0 };
  const exp = Number(val.slice(0, dot));
  const sig = val.slice(dot + 1);
  if (!exp || !eqHex(sig, sign(exp))) return { open: false, remainingMs: 0 };
  const left = exp - Date.now();
  if (left <= 0) return { open: false, remainingMs: 0 };
  return { open: true, remainingMs: left };
}

export function setGateCookie(res, on) {
  if (!on) {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return;
  }
  const exp = Date.now() + TTL_MS;
  const val = encodeURIComponent(exp + "." + sign(exp));
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${val}; Path=/; Max-Age=${Math.floor(TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Lax`,
  );
}

/** Returns true if the response is already finished (blocked or preflight). */
export function guard(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  if (readGate(req).open) return false;
  res.setHeader("Cache-Control", "no-store");
  res.status(401).json({ ok: false, locked: true, error: "Locked" });
  return true;
}
