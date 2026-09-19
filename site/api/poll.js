// Cron target: pull the card and save it without shipping 400 games back.
import { cors } from "./_db.js";
import { store } from "./_store.js";
import { fetchCard, normalise } from "./_card.js";
import { refreshSlips } from "./_slips.js";

export default async function handler(req, res) {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).end();

  const started = Date.now();
  const { events, errors } = await fetchCard();
  const games = [];
  for (const ev of events) {
    const g = normalise(ev);
    if (g) games.push(g);
  }
  let saved = 0, saveError = null;
  try { saved = await store(games); }
  catch (e) { saveError = String(e?.message || e); }

  let slips = null;
  try { slips = await refreshSlips(); }
  catch (e) { slips = { error: String(e?.message || e) }; }

  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ok: !saveError,
    tookMs: Date.now() - started,
    read: games.length,
    upcoming: games.filter((g) => g.upcoming).length,
    saved,
    slips,
    saveError,
    feedErrors: errors.length ? errors : null,
  });
}
