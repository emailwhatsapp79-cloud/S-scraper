// Open SportyBet bets for the connected account (owner-authorized): every
// minute, read each open slip's cash-out state and amount so the app can show
// it, and so the auto cash-out (on a danger flag, amount >= stake) has a value
// to act on. Reading only in this file; the cash-out itself lives elsewhere.
import { sql } from "./_db.js";
import { readSession, writeSession } from "./_fc_session.js";
import { withSession, postSecure } from "./_fc.js";
import { touchHealth } from "./_health.js";

let ready = false;
async function ensure() {
  if (ready) return;
  await sql`CREATE TABLE IF NOT EXISTS slip_cashout (
    order_id TEXT PRIMARY KEY,
    bet_id TEXT,
    cashable BOOLEAN,
    amount DOUBLE PRECISION,
    max_amount DOUBLE PRECISION,
    potential DOUBLE PRECISION,
    reason TEXT,
    updated TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;
  ready = true;
}

const SAFE = /cash|amount|status|orderid|betid|odds|stake|win|potential|settle|count|total|code|type|reason|coeff/i;
function shape(node, depth = 0) {
  if (node == null || depth > 4) return node == null ? null : "…";
  if (Array.isArray(node)) return node.length ? [shape(node[0], depth + 1), "len " + node.length] : [];
  if (typeof node !== "object") return typeof node;
  const out = {};
  for (const [k, v] of Object.entries(node).slice(0, 50)) {
    if (v && typeof v === "object") out[k] = shape(v, depth + 1);
    else out[k] = SAFE.test(k) ? v : typeof v;
  }
  return out;
}

const num = (v) => (v == null || v === "" || !isFinite(Number(v)) ? null : Number(v));

// Find a bet's cash-out entry in the cashOut/data reply, whatever its nesting.
function findEntry(node, betId, depth = 0) {
  if (!node || depth > 5) return null;
  if (Array.isArray(node)) {
    for (const x of node) { const hit = findEntry(x, betId, depth + 1); if (hit) return hit; }
    return null;
  }
  if (typeof node !== "object") return null;
  if (String(node.betId || node.id || "") === String(betId)) return node;
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") { const hit = findEntry(v, betId, depth + 1); if (hit) return hit; }
  }
  return null;
}

/** Read every open bet's cash-out state for slips the app booked. */
export async function readOpenBets() {
  const open = await sql`SELECT order_id FROM slips WHERE status IN ('open', 'live') AND order_id IS NOT NULL`;
  if (!open.length) return { open: 0 };
  let session = await readSession("sporty");
  if (!session) return { open: open.length, connected: false };
  await ensure();

  const list = await withSession(session, "/api/ng/orders/order/realbetlist?isSettled=0&pageSize=20&pageNo=1");
  if (list.session) { session = list.session; await writeSession(session); }
  const orders = (list.body && list.body.data && list.body.data.orders) || [];

  let data = null, dataNote = null;
  try {
    const hit = await postSecure(session, "/api/ng/realSportsGame/cashOut/data", { currency: "NGN" });
    if (hit.session && hit.session !== session) { session = hit.session; await writeSession(session); }
    if (hit.body && hit.body.bizCode === 10000) data = hit.body.data;
    else dataNote = { status: hit.status, biz: hit.body && hit.body.bizCode, msg: hit.body && String(hit.body.message || "").slice(0, 80) };
  } catch (e) { dataNote = { error: String(e?.message || e).slice(0, 80) }; }

  const wanted = new Set(open.map((r) => r.order_id));
  let saved = 0;
  for (const o of orders) {
    if (!wanted.has(o.orderId)) continue;
    const bet = (o.bets || [])[0] || {};
    const entry = data ? findEntry(data, bet.id) : null;
    const amount = num(entry && (entry.cashOutAmount ?? entry.maxCashOutAmount ?? entry.amount));
    const cashable = entry && (entry.isCashable ?? entry.isCashAble) != null
      ? !!(entry.isCashable ?? entry.isCashAble) : !!bet.isCashable;
    await sql`
      INSERT INTO slip_cashout (order_id, bet_id, cashable, amount, max_amount, potential, reason, updated)
      VALUES (${o.orderId}, ${String(bet.id || "")}, ${cashable}, ${amount},
        ${num(entry && entry.maxCashOutAmount)}, ${num(bet.potentialWinnings ?? o.potentialWinnings)},
        ${entry && entry.unCashableReason != null ? String(entry.unCashableReason) : null}, now())
      ON CONFLICT (order_id) DO UPDATE SET bet_id = EXCLUDED.bet_id, cashable = EXCLUDED.cashable,
        amount = EXCLUDED.amount, max_amount = EXCLUDED.max_amount, potential = EXCLUDED.potential,
        reason = EXCLUDED.reason, updated = now()`;
    saved++;
  }
  // Shape of the cash-out reply (no account details), to confirm the fields.
  await touchHealth("sb_cashout", { at: Date.now(), orders: orders.length, saved, dataNote, data: data ? shape(data) : null });
  return { open: open.length, orders: orders.length, saved, data: !!data };
}
