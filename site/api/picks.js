// Auto-ledger: every game the screen matched, settled after it played.
import { cors } from "./_db.js";
import { listPicks, settlePicks, recordStoredPicks } from "./_screen.js";
import { guard } from "./_gate.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;
  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const scope = url.searchParams.get("scope") || "settled";
  try {
    let recorded = 0, settled = 0;
    try { recorded = await recordStoredPicks(); } catch { /* keep listing */ }
    try { settled = await settlePicks(); } catch { /* keep listing */ }
    const picks = await listPicks(scope);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      tookMs: Date.now() - started,
      recorded,
      settled,
      count: picks.length,
      picks,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}