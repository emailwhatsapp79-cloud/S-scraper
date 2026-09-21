// Edge fetch of scores24. Vercel Node in Cape Town is 403; Cloudflare edge often is not.
export const config = { runtime: "edge" };

const KEY = process.env.GATE_SECRET || process.env.CRON_SECRET || "";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async function handler(req) {
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
