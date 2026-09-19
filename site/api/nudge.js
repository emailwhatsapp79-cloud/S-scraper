// Frequent tick: refresh booked slips and push Yes/No while the phone is locked.
import { cors } from "./_db.js";
import { refreshSlips } from "./_slips.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const started = Date.now();
  let slips = null;
  try { slips = await refreshSlips(); }
  catch (e) { slips = { error: String(e?.message || e) }; }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({ ok: !slips?.error, tookMs: Date.now() - started, slips });
}
