import { cors } from "./_db.js";
import { pinOk, hashPin, readGate, setGateCookie } from "./_gate.js";
import { savePinHash } from "./_vault.js";

function six(s) {
  return /^\d{6}$/.test(String(s || "").trim());
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const g = readGate(req);
    return res.status(200).json({ ok: true, open: g.open, remainingMs: g.remainingMs });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  if (body.lock) {
    setGateCookie(res, false);
    return res.status(200).json({ ok: true, open: false });
  }

  if (body.newPin != null) {
    if (!readGate(req).open) {
      return res.status(401).json({ ok: false, locked: true, error: "Locked" });
    }
    if (!(await pinOk(body.oldPin))) {
      return res.status(401).json({ ok: false, error: "Wrong current code" });
    }
    if (!six(body.newPin) || !six(body.oldPin)) {
      return res.status(400).json({ ok: false, error: "Code has to be six digits" });
    }
    await savePinHash(hashPin(body.newPin));
    return res.status(200).json({ ok: true, changed: true });
  }

  if (!(await pinOk(body.pin))) {
    return res.status(401).json({ ok: false, open: false, error: "Wrong code" });
  }
  setGateCookie(res, true);
  return res.status(200).json({ ok: true, open: true, remainingMs: 2 * 60 * 60 * 1000 });
}
