// Football.com account: one login, place a vFootball slip, gone after a day.
// The password is hashed in memory for the login call and never stored.
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { fetchEvent, FOOTBALL_BASE } from "./_card.js";

export const HOST = "https://www.football.com";
export const DAY_MS = 24 * 60 * 60 * 1000;
export const SPORT_ID = "sr:sport:202120001";

const UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

const WANT = {
  "1": ["1X2", "Home"],
  X: ["1X2", "Draw"],
  "2": ["1X2", "Away"],
  "1X": ["Double Chance", "Home or Draw"],
  "12": ["Double Chance", "Home or Away"],
  X2: ["Double Chance", "Draw or Away"],
};

const LOGIN_MSG = {
  11601: "Password is incorrect.",
  11602: "That Football.com account is locked.",
  11603: "Football.com did not accept that phone or password.",
  11010: "Password is incorrect.",
  11613: "That email is not verified on Football.com.",
  12400: "Football.com is asking for a text code. Turn off two-factor there, then connect again.",
  19000: "Football.com rejected that phone or password.",
};

export function md5(s) {
  return createHash("md5").update(String(s)).digest("hex");
}

// Football.com refuses a login that has no deviceId cookie (bizCode 19000).
export function deviceUuid() {
  const b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// Football.com logs in with the local number, no leading 0 and no 234.
export function normalisePhone(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("234") && d.length > 10) d = d.slice(3);
  if (d.startsWith("0")) d = d.slice(1);
  if (!/^([789]\d{9})$/.test(d)) {
    throw new Error("Use the Football.com phone, like 0803… or 803…");
  }
  return d;
}

export function maskPhone(phone) {
  const d = String(phone || "");
  if (d.length < 6) return "connected";
  return "0" + d.slice(0, 3) + "···" + d.slice(-3);
}

export function sessionAlive(session, now = Date.now()) {
  if (!session || !session.cookie || !session.expiresAt) return false;
  return Number(session.expiresAt) > now;
}

export function fcMatchUrl(g) {
  if (!g || !g.eventId) return "";
  const league = String(g.league || "");
  const cat = (league.split("·")[0] || league.split("-")[0] || "England").trim() || "England";
  const home = String(g.home || "Home").trim();
  const away = String(g.away || "Away").trim();
  const seg = (s) => encodeURIComponent(s).replace(/%2D/gi, "-");
  return `${HOST}/ng/m/n/sport/vFootball/${seg(cat)}/Virtual/${seg(home)}-vs-${seg(away)}/${g.eventId}`;
}

export function sharePageUrl(code) {
  return `${HOST}/ng/m?shareCode=${encodeURIComponent(code)}`;
}

export function selectionId(product, sportId, marketId, outcomeId) {
  return `uof:${product}/${sportId}/${marketId}/${outcomeId}`;
}

export function betslipKey(sportId, eventId, marketId, outcomeId) {
  return `${sportId}_${eventId}_${marketId}_${outcomeId}`;
}

// Naira in the app. Football.com moves money in 1/10000 of a naira.
export function units(naira) {
  return Math.round(Number(naira) * 10000);
}

export function fromUnits(n) {
  const v = Number(n);
  if (!isFinite(v)) return null;
  if (Math.abs(v) >= 10000) return Math.round(v) / 10000;
  return v;
}

export function movedTooFar(booked, live) {
  const a = Number(booked);
  const b = Number(live);
  if (!(a > 1) || !(b > 1)) return true;
  return b < a - 0.06 && (a - b) / a > 0.08;
}

function headers(session, extra = {}) {
  return {
    "User-Agent": UA,
    Accept: "application/json, text/plain, */*",
    Origin: HOST,
    Referer: `${HOST}/ng/m/`,
    Platform: "wap",
    ClientId: "wap",
    OperId: "8",
    ...(session && session.cookie ? { Cookie: session.cookie } : {}),
    ...extra,
  };
}

function readSetCookie(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

function cookieJar(setCookies, extras) {
  const jar = {};
  for (const line of setCookies || []) {
    const pair = String(line).split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
  for (const [k, v] of Object.entries(extras || {})) {
    if (v != null && v !== "") jar[k] = String(v);
  }
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function readJson(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { message: text.slice(0, 180) }; }
}

function failMessage(body, fallback) {
  const code = Number(body && body.bizCode);
  if (LOGIN_MSG[code]) return LOGIN_MSG[code];
  return (body && (body.message || body.innerMsg)) || fallback;
}

function aesEncrypt(plain, key) {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, ct]).toString("base64");
}

function aesDecrypt(payload, key) {
  const raw = Buffer.from(String(payload || "").trim(), "base64");
  if (raw.length < 32) throw new Error("short");
  const decipher = createDecipheriv("aes-128-cbc", key, raw.subarray(0, 16));
  return Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString("utf8");
}

async function patronKey() {
  const res = await fetch(`${HOST}/api/ng/patron/cipher`, {
    method: "POST",
    headers: headers(null),
  });
  const body = await readJson(res);
  if (body.bizCode !== 10000 || !body.data?.password || !body.data?.ursId) {
    throw new Error("Football.com did not open a login channel");
  }
  return { ursId: body.data.ursId, key: Buffer.from(body.data.password, "base64") };
}

export async function login(phone, password) {
  const username = normalisePhone(phone);
  const deviceId = deviceUuid();
  const fingerprint = randomBytes(16).toString("hex");
  const { ursId, key } = await patronKey();
  const form = `username=${encodeURIComponent(username)}&password=${encodeURIComponent(md5(password))}&keepSignedIn=false`;
  const res = await fetch(`${HOST}/api/ng/patron/accessToken`, {
    method: "POST",
    headers: headers(null, {
      "Content-Type": "text/plain",
      "encryption-type": "1",
      ursId,
      Fingerprint: fingerprint,
      Cookie: `deviceId=${deviceId}`,
    }),
    body: aesEncrypt(form, key),
  });
  const raw = await res.text();
  let body = {};
  try { body = JSON.parse(aesDecrypt(raw, key)); }
  catch { try { body = JSON.parse(raw); } catch { body = { message: raw.slice(0, 180) }; } }
  if (body.bizCode !== 10000) {
    throw new Error(failMessage(body, "Football.com did not accept that login"));
  }
  const data = body.data || {};
  const accessToken = data.accessToken || data.token || "";
  const refreshToken = data.refreshToken || "";
  const userId = String(data.userId || data.userID || "");
  const cookie = cookieJar(readSetCookie(res), {
    accessToken, refreshToken, userId, deviceId,
  });
  if (!cookie || (!accessToken && !cookie.includes("accessToken="))) {
    throw new Error("Football.com signed in but did not return a session");
  }
  const loggedInAt = Date.now();
  return {
    loggedInAt,
    expiresAt: loggedInAt + DAY_MS,
    phone: username,
    userId,
    accessToken,
    refreshToken,
    deviceId,
    cookie,
  };
}

export async function logoutRemote(session) {
  if (!session || !session.cookie) return;
  try {
    await fetch(`${HOST}/api/ng/patron/accessToken/delete`, {
      method: "DELETE",
      headers: headers(session),
    });
  } catch { /* local logout still stands */ }
}

async function authed(session, path, opts = {}) {
  const res = await fetch(`${HOST}${path}`, {
    method: opts.method || "GET",
    headers: headers(session, opts.headers || {}),
    body: opts.body,
  });
  const body = await readJson(res);
  return { status: res.status, body, res };
}

function authDead(status, body) {
  if (status === 401 || status === 403) return true;
  const code = Number(body && body.bizCode);
  return code === 401 || code === 403 || code === 43001;
}

export async function refreshSession(session) {
  if (!sessionAlive(session)) throw new Error("Football.com signed out after one day");
  const res = await fetch(`${HOST}/api/ng/patron/refreshToken`, {
    method: "PUT",
    headers: headers(session, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: "keepSignedIn=false",
  });
  const body = await readJson(res);
  if (body.bizCode !== 10000) throw new Error("Football.com session ended. Connect again.");
  const data = body.data || {};
  const accessToken = data.accessToken || session.accessToken;
  const refreshToken = data.refreshToken || session.refreshToken;
  const userId = String(data.userId || session.userId || "");
  const cookie = cookieJar(readSetCookie(res), {
    accessToken, refreshToken, userId, deviceId: session.deviceId,
  }) || session.cookie;
  return {
    ...session,
    accessToken,
    refreshToken,
    userId,
    cookie,
    // The day starts at login. A refresh must not stretch it.
    expiresAt: session.expiresAt,
    loggedInAt: session.loggedInAt,
  };
}

export async function withSession(session, path, opts) {
  let current = session;
  let hit = await authed(current, path, opts);
  if (authDead(hit.status, hit.body)) {
    current = await refreshSession(current);
    hit = await authed(current, path, opts);
    hit.session = current;
  }
  return hit;
}

function walkBalance(node, depth = 0) {
  if (!node || depth > 5) return null;
  if (Array.isArray(node)) {
    for (const x of node) {
      const n = walkBalance(x, depth + 1);
      if (n != null) return n;
    }
    return null;
  }
  if (typeof node !== "object") return null;
  for (const k of ["avlBal", "availableBalance", "balance", "avlAmount", "cashBalance"]) {
    if (node[k] != null && isFinite(Number(node[k]))) return fromUnits(node[k]);
  }
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const n = walkBalance(v, depth + 1);
      if (n != null) return n;
    }
  }
  return null;
}

export async function loadBalance(session) {
  const paths = [
    "/api/ng/pocket/v1/wallet/assets",
    "/api/ng/pocket/v1/finAccs/finAcc/userBal",
  ];
  let current = session;
  for (const path of paths) {
    const hit = await withSession(current, path);
    current = hit.session || current;
    if (hit.body && hit.body.bizCode === 10000) {
      const n = walkBalance(hit.body.data);
      if (n != null) return { session: current, balance: Math.round(n * 100) / 100 };
    }
  }
  return { session: current, balance: null };
}

function giftAmount(g) {
  if (g.curBal != null) return fromUnits(g.curBal);
  if (g.currentBalance != null) return fromUnits(g.currentBalance);
  return null;
}

function giftLeast(g) {
  const n = Number(g.leastOrderAmount);
  if (!isFinite(n) || n <= 0) return 0;
  return n >= 100000 ? n / 10000 : n;
}

export async function loadGifts(session) {
  const q = new URLSearchParams({
    _t: String(Date.now()),
    betType: "0",
    deviceCh: "3",
    bizType: "1",
  });
  const hit = await withSession(session, `/api/ng/promotion/v1/gifts/groupQuery?${q}`);
  const gifts = [];
  const groups = hit.body && hit.body.bizCode === 10000 ? (hit.body.data || []) : [];
  for (const group of groups) {
    for (const g of group.gifts || []) {
      if (g.bvnVerified === false) continue;
      const status = Number(g.status);
      if (status === 40 || status === 90) continue;
      const amount = giftAmount(g);
      if (!(amount > 0)) continue;
      gifts.push({
        id: String(g.giftId || g.id || ""),
        name: g.displayTitle || g.title || g.displayName || "Gift",
        amount: Math.round(amount * 100) / 100,
        least: giftLeast(g),
        expire: g.expireTime || g.expireAt || null,
      });
    }
  }
  gifts.sort((a, b) => b.amount - a.amount);
  return { session: hit.session || session, gifts: gifts.filter((g) => g.id) };
}

export function quote(ev, selection) {
  const want = WANT[String(selection || "")];
  if (!ev || !want) return null;
  const [desc, outcome] = want;
  const markets = (ev.markets || []).filter((m) => String(m.desc || "") === desc);
  markets.sort((a, b) => {
    const liveA = a.product === 1 ? 1 : 0;
    const liveB = b.product === 1 ? 1 : 0;
    const started = /^(H1|H2|HT|LIVE)/i.test(String(ev.matchStatus || ""));
    if (started && liveA !== liveB) return liveB - liveA;
    if (!started && liveA !== liveB) return liveA - liveB;
    return (Number(b.lastOddsChangeTime) || 0) - (Number(a.lastOddsChangeTime) || 0);
  });
  for (const m of markets) {
    const o = (m.outcomes || []).find((x) => String(x.desc || "") === outcome);
    const odds = Number(o && o.odds);
    if (!o || !(odds > 1) || o.isActive === 0) continue;
    const sportId = (ev.sport && ev.sport.id) || SPORT_ID;
    const marketId = String(m.id || m.marketId);
    const outcomeId = String(o.id || o.outcomeId);
    const product = String(m.product ?? 3);
    return {
      eventId: String(ev.eventId),
      sportId,
      marketId,
      outcomeId,
      product,
      odds,
      probability: o.probability != null ? String(o.probability) : "",
    };
  }
  return null;
}

export async function priceLeg(leg) {
  const ev = await fetchEvent(leg.eventId, {}, FOOTBALL_BASE);
  const q = quote(ev, leg.selection);
  if (!q) {
    throw new Error(`${leg.home} v ${leg.away} is not open on Football.com. Refresh the card.`);
  }
  if (movedTooFar(leg.price, q.odds)) {
    throw new Error(
      `${leg.home} v ${leg.away} moved from ${Number(leg.price).toFixed(2)} to ${q.odds.toFixed(2)}. Refresh, then place again.`,
    );
  }
  return {
    ...leg,
    eventId: q.eventId,
    sportId: q.sportId,
    marketId: q.marketId,
    outcomeId: q.outcomeId,
    product: q.product,
    price: q.odds,
    probability: q.probability,
  };
}

export function buildOrder(legs, stake, gift) {
  const list = legs || [];
  if (!list.length) throw new Error("Nothing to place");
  const naira = Number(stake);
  if (!(naira > 0)) throw new Error("Stake has to be above 0");
  const selections = list.map((l) => {
    const product = String(l.product || "3");
    const sportId = l.sportId || SPORT_ID;
    const marketId = String(l.marketId);
    const outcomeId = String(l.outcomeId);
    return {
      eventId: String(l.eventId),
      id: selectionId(product, sportId, marketId, outcomeId),
      marketId,
      odds: String(l.price),
      probability: l.probability ? String(l.probability) : "",
      twoUpFactor: 1,
      banker: false,
      betslipKey: betslipKey(sportId, l.eventId, marketId, outcomeId),
    };
  });
  const multiple = selections.length > 1;
  const stakeUnits = units(naira);
  const bets = multiple
    ? [{ selectedSystems: [selections.length], stake: { value: stakeUnits } }]
    : [{ selectedSystems: [1], stake: { value: stakeUnits }, selectionRefs: [{ selectionIndex: 0 }] }];
  let payUnits = stakeUnits;
  let favor;
  if (gift && gift.id) {
    const cover = Math.min(naira, Number(gift.amount) || 0);
    if (!(cover > 0)) throw new Error("That gift has nothing left on it");
    if (gift.least > naira) throw new Error(`That gift needs a stake of at least ₦${gift.least}`);
    payUnits = units(Math.max(naira - cover, 0));
    favor = { favorInfo: [{ giftId: String(gift.id) }] };
  }
  const order = {
    bizType: 1,
    orderType: multiple ? 2 : 1,
    subBizType: 1,
    paymentType: 0,
    actualPayAmount: payUnits,
    isBonusFactor: false,
    ticket: { selections, bets },
  };
  if (favor) order.favor = favor;
  return order;
}

export async function placeOrder(session, legs, stake, gift) {
  const priced = [];
  for (const leg of legs) priced.push(await priceLeg(leg));
  const order = buildOrder(priced, stake, gift);
  const hit = await withSession(session, "/api/ng/orders/order", {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify(order),
  });
  const body = hit.body || {};
  if (body.bizCode !== 10000) {
    throw new Error(failMessage(body, "Football.com refused the bet"));
  }
  const data = body.data || {};
  const orderId = String(data.orderId || data.shortId || data.ticketId || "");
  if (!orderId) throw new Error("Football.com did not return a bet number");
  return {
    session: hit.session || session,
    orderId,
    shortId: data.shortId ? String(data.shortId) : "",
    legs: priced,
  };
}
