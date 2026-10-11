import { guard } from "./_gate.js";
import { saveSub, dropSubPublic, testSub, VAPID_PUBLIC } from "./_push.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    return res.status(200).json({ ok: true, publicKey: VAPID_PUBLIC });
  }
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  try {
    if (body.off) {
      await dropSubPublic(body.endpoint || "");
      return res.status(200).json({ ok: true, off: true });
    }
    await saveSub(body);
    if (body.test) return res.status(200).json({ ok: true, test: await testSub(body) });
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
}