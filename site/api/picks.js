// Auto-ledger: every game the screen matched, settled after it played.
import { cors } from "./_db.js";
import { listPicks, settlePicks } from "./_screen.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const started = Date.now();
  const url = new URL(req.url, "http://x");
  const scope = url.searchParams.get("scope") || "settled";
  try {
    if (url.searchParams.get("settle") === "1") {
      try { await settlePicks(); } catch (e) { /* best effort */ }
    }
    const picks = await listPicks(scope);
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: true, tookMs: Date.now() - started, count: picks.length, picks });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e) });
  }
}
