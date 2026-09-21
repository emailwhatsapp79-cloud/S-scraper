// Night tick: booked slips + a TT history chunk so the pile grows with the
// tab closed. Hobby only allows two daily crons — this is the second.
import { cors } from "./_db.js";
import { refreshSlips } from "./_slips.js";
import { pullScores24 } from "./_s24.js";
import { countsTT } from "./_tt.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();
  const started = Date.now();
  let slips = null;
  try { slips = await refreshSlips(); }
  catch (e) { slips = { error: String(e?.message || e) }; }
  let s24 = null, counts = { total: 0, settled: 0 };
  try {
    s24 = await pullScores24([], {
      skipHtml: true, more: true, pages: 5, first: 50, days: 400,
      players: 0, deadlineMs: 20000,
    });
  } catch (e) { s24 = { error: String(e?.message || e) }; }
  try { counts = await countsTT(); } catch { /* ignore */ }
  res.setHeader("Cache-Control", "no-store");
  return res.status(200).json({
    ok: !slips?.error,
    tookMs: Date.now() - started,
    slips, s24,
    settled: counts.settled,
  });
}