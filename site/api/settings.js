import { guard, setGateCookie, clampLockMin, LOCK_MINS } from "./_gate.js";
import { loadPrefs, savePrefs, publicPrefs } from "./_vault.js";
import { readHealth } from "./_health.js";
import { countsVF } from "./_results.js";
import { countsTT } from "./_tt.js";
import { logErr } from "./_db.js";

const SHAPE_KEYS = [
  "ft_fav_min", "ft_fav_max", "ft_dog_min",
  "ft_dc_fav_min", "ft_dc_fav_max", "ft_dc_dog_min",
  "ht_fav_min", "ht_fav_max", "ht_ratio_min",
];

function cleanShape(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  for (const k of SHAPE_KEYS) {
    const v = Number(raw[k]);
    if (!isFinite(v) || v <= 0) return null;
    out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

export default async function handler(req, res) {
  if (guard(req, res)) return;
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "GET") {
    const p = await loadPrefs();
    let health = {}, vf = { total: 0, settled: 0 }, tt = { total: 0, settled: 0 };
    try { health = await readHealth(); } catch (e) { logErr("settings.health", e); }
    try { vf = await countsVF(); } catch (e) { logErr("settings.vf", e); }
    try { tt = await countsTT(); } catch (e) { logErr("settings.tt", e); }
    return res.status(200).json({
      ok: true, ...publicPrefs(p), lockMins: LOCK_MINS,
      health, vf, tt,
    });
  }

  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "GET or POST" });
  const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
  const patch = {};
  const shape = cleanShape(body.shape);
  if (shape) patch.shape = shape;
  if (typeof body.pings === "boolean") patch.pings = body.pings;
  if (typeof body.bio === "boolean") patch.bio = body.bio;
  if (body.lockMin != null) patch.lockMin = clampLockMin(body.lockMin);
  const p = Object.keys(patch).length ? await savePrefs(patch) : await loadPrefs();
  if (patch.lockMin != null) {
    const ms = await setGateCookie(res, true);
    return res.status(200).json({ ok: true, ...publicPrefs(p), lockMins: LOCK_MINS, remainingMs: ms });
  }
  return res.status(200).json({ ok: true, ...publicPrefs(p), lockMins: LOCK_MINS });
}
