// Paper book. GET lists slips (and refreshes scores). POST saves a new slip.
// ?account=1 is the Football.com login. It lives here so the site stays
// inside Vercel's serverless-function cap.
import { cors } from "./_db.js";
import { listSlips, createSlip, refreshSlips, reshareSlip } from "./_slips.js";
import { guard } from "./_gate.js";
import account, { handle as accountHandle } from "./_fc_session.js";

export default async function handler(req, res) {
  if (guard(req, res)) return;

  const started = Date.now();
  try {
    const url = new URL(req.url || "/", "http://x");
    const which = url.searchParams.get("account");
    if (which === "1" || which === "football") return account(req, res);
    if (which === "sporty") return accountHandle(req, res, "sporty");

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const slip = body.slipId
        ? await reshareSlip(body.slipId)
        : await createSlip(body.stake, body.legs || body.gameIds, body.book, {
          pay: body.pay, giftId: body.giftId,
        });
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ ok: true, tookMs: Date.now() - started, slip });
    }

    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET or POST" });

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
