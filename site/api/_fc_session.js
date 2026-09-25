// Football.com login for this site. The session is sealed in the vault and
// thrown away 24 hours after it was created. The password is not stored.
import { guard } from "./_gate.js";
import { seal, open } from "./_crypto.js";
import { sql } from "./_db.js";
import {
  login, logoutRemote, loadBalance, loadGifts, sessionAlive, maskPhone, DAY_MS,
} from "./_fc.js";

const KEYS = { football: "fc_session", sporty: "sb_session" };

function vaultKey(book) {
  return book === "sporty" ? KEYS.sporty : KEYS.football;
}

async function ensure() {
  await sql`CREATE TABLE IF NOT EXISTS vault (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
}

async function readSession(book = "football") {
  await ensure();
  const key = vaultKey(book);
  const rows = await sql`SELECT v FROM vault WHERE k = ${key}`;
  if (!rows[0]) return null;
  const data = open(rows[0].v);
  if (!data || typeof data !== "object") return null;
  if (!sessionAlive(data)) {
    await sql`DELETE FROM vault WHERE k = ${key}`;
    logoutRemote(data);
    return null;
  }
  return data;
}

async function writeSession(session) {
  await ensure();
  const key = vaultKey(session && session.book);
  const packed = seal(session);
  await sql`
    INSERT INTO vault (k, v, updated) VALUES (${key}, ${packed}, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()`;
}

async function clearSession(book = "football") {
  await ensure();
  const key = vaultKey(book);
  await sql`DELETE FROM vault WHERE k = ${key}`;
}

function view(session, extra = {}) {
  if (!session) {
    return { ok: true, connected: false, dayMs: DAY_MS, ...extra };
  }
  return {
    ok: true,
    connected: true,
    phone: maskPhone(session.phone),
    expiresAt: session.expiresAt,
    remainingMs: Math.max(0, session.expiresAt - Date.now()),
    dayMs: DAY_MS,
    balance: extra.balance ?? null,
    gifts: extra.gifts || [],
  };
}

export async function handle(req, res, book = "football") {
  if (guard(req, res)) return;
  res.setHeader("Cache-Control", "no-store");
  const label = book === "sporty" ? "SportyBet" : "Football.com";
  try {
    if (req.method === "DELETE") {
      const cur = await readSession(book);
      if (cur) await logoutRemote(cur);
      await clearSession(book);
      return res.status(200).json(view(null, { reason: "signed out" }));
    }

    if (req.method === "POST") {
      const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
      const session = await login(body.phone, body.password, book);
      await writeSession(session);
      let balance = null;
      let gifts = [];
      try {
        const bal = await loadBalance(session);
        balance = bal.balance;
        if (bal.session && bal.session.cookie !== session.cookie) await writeSession(bal.session);
        const g = await loadGifts(bal.session || session);
        gifts = g.gifts;
        if (g.session && g.session !== (bal.session || session)) await writeSession(g.session);
      } catch { /* login still stands; balance can load on the next open */ }
      return res.status(200).json(view(session, { balance, gifts }));
    }

    if (req.method !== "GET") return res.status(405).json({ ok: false, error: "GET, POST or DELETE" });

    const session = await readSession(book);
    if (!session) return res.status(200).json(view(null));
    let balance = null;
    let gifts = [];
    try {
      const bal = await loadBalance(session);
      balance = bal.balance;
      const next = bal.session || session;
      const g = await loadGifts(next);
      gifts = g.gifts;
      if (g.session && g.session.cookie !== session.cookie) await writeSession(g.session);
    } catch (e) {
      return res.status(200).json(view(session, { balanceError: String(e.message || e) }));
    }
    return res.status(200).json(view(session, { balance, gifts }));
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e).replaceAll("Football.com", label) });
  }
}

export default function handler(req, res) {
  return handle(req, res, "football");
}

export { readSession, writeSession, clearSession };
