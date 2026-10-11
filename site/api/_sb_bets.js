// Open SportyBet bets for the connected account (the owner asked for live
// cash-out values and automatic cash-out on a danger flag). Step one is
// read-only discovery: it records only the shape of each reply (status, field
// names, cash/amount values), never tokens or account details, in health
// 'sb_probe', so the cash-out call can be built on the real fields.
import { sql } from "./_db.js";
import { readSession, writeSession } from "./_fc_session.js";
import { withSession } from "./_fc.js";
import { touchHealth } from "./_health.js";

const LIST = [
  "/api/ng/orders/order/v2/realbetlist?isSettled=0&pageSize=10&pageNo=1",
  "/api/ng/orders/order/realbetlist?isSettled=0&pageSize=10&pageNo=1",
  "/api/ng/orders/order/v3/realbetlist?isSettled=0&pageSize=10&pageNo=1",
  "/api/ng/orders/order/v2/realbets?isSettled=0&pageSize=10&pageNo=1",
  "/api/ng/orders/order/v1/realbetlist?isSettled=0&pageSize=10&pageNo=1",
];
const BY_ID = [
  "/api/ng/orders/order/detail?orderId=",
  "/api/ng/orders/order/v2/detail?orderId=",
  "/api/ng/orders/order/v2/orderDetail?orderId=",
  "/api/ng/orders/cashout/v1/amount?orderId=",
  "/api/ng/orders/cashout/amount?orderId=",
];

const SAFE = /cash|amount|status|orderid|odds|stake|win|potential|settle|count|total|code|type/i;

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

export async function probeBets() {
  const session = await readSession("sporty");
  if (!session) return { connected: false };
  const open = await sql`SELECT order_id FROM slips WHERE order_id IS NOT NULL ORDER BY created_at DESC LIMIT 1`;
  const orderId = open[0] && open[0].order_id;
  const found = [];
  let current = session;
  for (const path of [...LIST, ...(orderId ? BY_ID.map((p) => p + encodeURIComponent(orderId)) : [])]) {
    try {
      const hit = await withSession(current, path);
      if (hit.session) { current = hit.session; await writeSession(current); }
      found.push({
        path: orderId ? path.replace(encodeURIComponent(orderId), "{id}") : path,
        status: hit.status,
        biz: hit.body && hit.body.bizCode,
        msg: hit.body && String(hit.body.message || "").slice(0, 80),
        data: hit.body && hit.body.bizCode === 10000 ? shape(hit.body.data) : undefined,
      });
    } catch (e) {
      found.push({ path, error: String(e?.message || e).slice(0, 80) });
    }
  }
  await touchHealth("sb_probe", { at: Date.now(), found });
  return { connected: true, tried: found.length, ok: found.filter((f) => f.biz === 10000).length };
}
