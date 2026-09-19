import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const SECRET = process.env.GATE_SECRET || "3ed841c2806431522acc2d288f64f1fc275800b5c9ad19fc";

function key() {
  return createHash("sha256").update("vfs-vault-v1:" + SECRET).digest();
}

export function seal(obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function open(b64) {
  const buf = Buffer.from(String(b64 || ""), "base64");
  if (buf.length < 29) return null;
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const enc = buf.subarray(28);
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  const json = Buffer.concat([d.update(enc), d.final()]).toString("utf8");
  return JSON.parse(json);
}
