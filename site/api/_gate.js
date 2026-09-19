// Personal PIN gate. Cookie lasts two hours. Override PIN with env GATE_PIN.
import { createHash, createHmac, timingSafeEqual } from "crypto";
import { cors } from "./_db.js";

const SALT = "vfs-gate-v1";
const PIN_HASH = "2fcab7630a7b3dedf2714093c852e586b323a9e10764ba0084d0bfecc76d5a0b";
const SECRET = process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";
const TTL_MS = 2 * 60 * 60 * 1000;
const COOKIE = "vfs_gate";

function sha(s) {
  return createHash("sha256").update(s).digest("hex");
}

function wantHash() {
  const env = process.env.GATE_PIN;
  return env ? sha(SALT + String(env).trim()) : PIN_HASH;
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

export function pinOk(pin) {
  const got = sha(SALT + String(pin || "").trim());
  return eqHex(got, wantHash());
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
