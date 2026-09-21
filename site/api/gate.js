import { cors } from "./_db.js";
import { pinOk, hashPin, readGate, setGateCookie, sessionMs } from "./_gate.js";
import { savePinHash, loadPrefs } from "./_vault.js";
import { hasBio, beginRegister, finishRegister, beginAuth, finishAuth } from "./_bio.js";

function six(s) {
  return /^\d{6}$/.test(String(s || "").trim());
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const g = readGate(req);
    let enrolled = false;
    try { enrolled = await hasBio(); } catch { /* vault may be empty */ }
    let enabled = true;
    try {
      const p = await loadPrefs();
      enabled = p.bio !== false;
    } catch { /* default on */ }
    const ttlMs = await sessionMs();
    return res.status(200).json({
      ok: true, open: g.open, remainingMs: g.remainingMs,
      bio: enrolled && enabled, bioEnrolled: enrolled, ttlMs,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});

  if (body.lock) {
    await setGateCookie(res, false);
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

  if (body.bio === "register-options") {
    if (!readGate(req).open) return res.status(401).json({ ok: false, locked: true, error: "Locked" });
    try {
      const options = await beginRegister(req);
      return res.status(200).json({ ok: true, options });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (body.bio === "register") {
    if (!readGate(req).open) return res.status(401).json({ ok: false, locked: true, error: "Locked" });
    try {
      await finishRegister(req, body.cred);
      return res.status(200).json({ ok: true, bio: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (body.bio === "options") {
    try {
      const options = await beginAuth(req);
      return res.status(200).json({ ok: true, options });
    } catch (e) {
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }

  if (body.bio === "assert") {
    try {
      await finishAuth(req, body.cred);
      const ms = await setGateCookie(res, true);
      return res.status(200).json({ ok: true, open: true, remainingMs: ms, bio: true });
    } catch (e) {
      return res.status(401).json({ ok: false, open: false, error: String(e.message || e) });
    }
  }

  if (!(await pinOk(body.pin))) {
    return res.status(401).json({ ok: false, open: false, error: "Wrong code" });
  }
  const ms = await setGateCookie(res, true);
  return res.status(200).json({ ok: true, open: true, remainingMs: ms });
}
