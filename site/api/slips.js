// Paper book. GET lists slips (and refreshes scores). POST saves a new slip.
import { cors } from "./_db.js";
import { listSlips, createSlip, refreshSlips } from "./_slips.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const started = Date.now();
  try {
    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const slip = await createSlip(body.stake, body.gameIds);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, tookMs: Date.now() - started, slip });
    }

    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET or POST" });

    const url = new URL(req.url, "http://x");
    const refreshNow = url.searchParams.get("live") === "1";
    let refresh = null;
    if (refreshNow) {
      try { refresh = await refreshSlips(); }
      catch (e) { refresh = { error: String(e?.message || e) }; }
    }
    const slips = await listSlips();
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      tookMs: Date.now() - started,
      refresh,
      count: slips.length,
      slips,
    });
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String(e?.message || e), tookMs: Date.now() - started });
  }
}
