// Personal PIN + fingerprint gate. Session length is Settings → Auto lock.
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cors } from "./_db.js";
import { loadPinHash } from "./_vault.js";

const SALT = "vfs-gate-v1";
const PIN_HASH = "a1130bfe4270bc67bed0b71f0ae687df544ee38a5b342a468b15549612e9629f";
const SECRET = process.env.GATE_SECRET || process.env.CRON_SECRET || "vfs-dev-only";
export const TTL_MS = 30 * 60 * 1000;
export const LOCK_MINS = [30, 60, 120, 180, 240, 300, 360, 1440];

export function clampLockMin(n) {
  const m = Number(n);
  if (!isFinite(m)) return 30;
  let best = 30;
  for (const a of LOCK_MINS) if (Math.abs(a - m) < Math.abs(best - m)) best = a;
  return best;
}
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

export async function sessionMs() {
  try {
    const { loadPrefs } = await import("./_vault.js");
    const p = await loadPrefs();
    return clampLockMin(p.lockMin) * 60 * 1000;
  } catch {
    return TTL_MS;
  }
}

export async function setGateCookie(res, on) {
  if (!on) {
    res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`);
    return 0;
  }
  const ms = await sessionMs();
  const exp = Date.now() + ms;
  const val = encodeURIComponent(exp + "." + sign(exp));
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${val}; Path=/; Max-Age=${Math.floor(ms / 1000)}; HttpOnly; Secure; SameSite=Lax`,
  );
  return ms;
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

function header(req, name) {
  const h = req.headers || {};
  return h[name] || h[name.toLowerCase()] || "";
}

function eqStr(a, b) {
  try {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    if (!x.length || x.length !== y.length) return false;
    return timingSafeEqual(x, y);
  } catch {
    return false;
  }
}

/** Cron / GitHub Action / fill jobs. Not the user PIN. */
export function fillOk(req) {
  const want = process.env.GATE_SECRET || process.env.CRON_SECRET || "";
  if (!want) return false;
  const key = header(req, "x-fill-key");
  if (key && eqStr(key, want)) return true;
  const auth = String(header(req, "authorization") || "");
  const bearer = auth.replace(/^Bearer\s+/i, "");
  if (bearer && eqStr(bearer, want)) return true;
  const cron = process.env.CRON_SECRET;
  if (cron && bearer && eqStr(bearer, cron)) return true;
  const ua = String(header(req, "user-agent") || "");
  if (/^vercel-cron\b/i.test(ua)) return true;
  return false;
}

/** Returns true if the response is already finished (blocked). */
export function requireFill(req, res) {
  cors(res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }
  if (fillOk(req)) return false;
  res.setHeader("Cache-Control", "no-store");
  res.status(401).json({ ok: false, error: "no" });
  return true;
}
