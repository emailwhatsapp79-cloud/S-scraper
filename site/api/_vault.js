import { sql } from "./_db.js";
import { seal, open } from "./_crypto.js";

let ready = false;

export async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS vault (
    k TEXT PRIMARY KEY,
    v TEXT NOT NULL,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  ready = true;
}

const EMPTY = { shape: null, bankroll: null, pings: true, bio: true, lockMin: 30 };

export async function loadPrefs() {
  await ensure();
  const rows = await sql`SELECT v FROM vault WHERE k = 'prefs'`;
  if (!rows[0]) return { ...EMPTY };
  try {
    const data = open(rows[0].v);
    const lockMin = Number(data && data.lockMin);
    return {
      shape: data && data.shape && typeof data.shape === "object" ? data.shape : null,
      bankroll: data && data.bankroll && typeof data.bankroll.amount === "number" ? data.bankroll : null,
      pings: data && data.pings === false ? false : true,
      bio: data && data.bio === false ? false : true,
      lockMin: Number.isFinite(lockMin) ? lockMin : 30,
    };
  } catch {
    return { ...EMPTY };
  }
}

export async function savePrefs(patch) {
  const cur = await loadPrefs();
  const next = {
    shape: patch.shape && typeof patch.shape === "object" ? patch.shape : cur.shape,
    bankroll: patch.bankroll && typeof patch.bankroll.amount === "number" ? patch.bankroll : cur.bankroll,
    pings: typeof patch.pings === "boolean" ? patch.pings : cur.pings,
    bio: typeof patch.bio === "boolean" ? patch.bio : cur.bio,
    lockMin: patch.lockMin != null ? patch.lockMin : cur.lockMin,
  };
  const packed = seal(next);
  await sql`
    INSERT INTO vault (k, v, updated) VALUES ('prefs', ${packed}, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()`;
  return next;
}

export async function debitBankroll(n) {
  const cur = await loadPrefs();
  if (!cur.bankroll) return cur;
  const amount = Math.round((Number(cur.bankroll.amount) - Number(n)) * 100) / 100;
  return savePrefs({
    bankroll: {
      amount,
      starting: cur.bankroll.starting ?? cur.bankroll.amount,
      updated: new Date().toISOString(),
    },
  });
}

export function publicPrefs(p) {
  return {
    shape: p.shape,
    bankroll: p.bankroll ? { amount: p.bankroll.amount, starting: p.bankroll.starting || p.bankroll.amount } : null,
    pings: p.pings !== false,
    bio: p.bio !== false,
    lockMin: p.lockMin || 30,
  };
}

export async function loadPinHash() {
  await ensure();
  const rows = await sql`SELECT v FROM vault WHERE k = 'pin'`;
  const h = rows[0] && String(rows[0].v || "");
  return /^[a-f0-9]{64}$/i.test(h) ? h.toLowerCase() : null;
}

export async function savePinHash(hash) {
  await ensure();
  const h = String(hash || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(h)) throw new Error("Bad pin hash");
  await sql`
    INSERT INTO vault (k, v, updated) VALUES ('pin', ${h}, now())
    ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated = now()`;
}
