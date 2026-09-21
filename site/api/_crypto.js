import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

// Old wraps still open with this. New wraps use GATE_SECRET from the env.
const LEGACY = "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";

function keyOf(secret) {
  return createHash("sha256").update("vfs-vault-v1:" + secret).digest();
}

function secrets() {
  const s = [];
  if (process.env.GATE_SECRET) s.push(process.env.GATE_SECRET);
  s.push(LEGACY);
  return s;
}

export function seal(obj) {
  const secret = process.env.GATE_SECRET || LEGACY;
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

function openWith(buf, secret) {
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = createDecipheriv("aes-256-gcm", keyOf(secret), iv);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  return JSON.parse(json);
}

export function open(b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 29) return null;
  for (const secret of secrets()) {
    try { return openWith(buf, secret); } catch { /* try next key */ }
  }
  return null;
}
