// Edge fetch of scores24. Vercel Node in Cape Town is 403; Cloudflare edge often is not.
export const config = { runtime: "edge" };

// Same key as _s24.js fillKey(): the secret when one is set, else a hash of
// DATABASE_URL, so the relay works on deployments without a secret.
async function relayKey() {
  const k = process.env.GATE_SECRET || process.env.CRON_SECRET;
  if (k) return k;
  const db = process.env.DATABASE_URL || "";
  if (!db) return "";
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("vfs-s24:" + db));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async function handler(req) {
  const KEY = await relayKey();
  if (!KEY || (req.headers.get("x-fill-key") || "") !== KEY) {
    return new Response("no", { status: 401 });
  }
  const url = new URL(req.url);
  const kind = url.searchParams.get("kind") || "html";
  const target = kind === "rapi"
    ? url.searchParams.get("u")
    : "https://scores24.live/en/table-tennis";
  if (kind === "rapi") {
    if (!target || !target.startsWith("https://scores24.live/rapi/")) {
      return new Response("bad", { status: 400 });
    }
  }
  const r = await fetch(target, {
    headers: {
      "User-Agent": UA,
      Accept: kind === "rapi" ? "application/json" : "text/html",
      Origin: "https://scores24.live",
      Referer: "https://scores24.live/en/table-tennis",
    },
  });
  return new Response(await r.text(), {
    status: r.status,
    headers: { "content-type": r.headers.get("content-type") || "text/plain" },
  });
}
