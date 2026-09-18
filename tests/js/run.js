/* Drives the userscript against a mock feed and checks what it shows. */
const assert = require("assert");
const { boot } = require("./harness.js");
const feed = require("./mock_feed.js");

const LIST = "https://www.sportybet.com/api/ng/factsCenter/vFootball?pageNum=1&pageSize=100";
const P2 = LIST.replace("pageNum=1", "pageNum=2");

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
const settle = () => new Promise((r) => setImmediate(() => setImmediate(() => setImmediate(r)))); 

async function drive(routes, seedUrl) {
  const app = boot(routes);
  await app.siteFetched(seedUrl);      // the site loads its own card
  app.find.click();                     // the user taps FIND
  for (let i = 0; i < 40; i++) await settle();
  return app;
}

test("finds the one game that survives, from a page the site fetched", async () => {
  const app = await drive({ [LIST]: feed.page(feed.card), [P2]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /Went through <b>4<\/b> games/);
});

test("the survivor is CRY vs NFO and its game id is shown", async () => {
  const card = feed.card.slice();
  card[2] = feed.event("52355", "CRY", "NFO", [1.84, 4.35, 3.88], [1.29, 1.25, 1.99], [2.20, 2.60, 4.60]);
  const app = await drive({ [LIST]: feed.page(card), [P2]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /<b>1<\/b> matched/);
  const shown = app.out.children.map((c) => c.innerHTML).join("");
  assert.match(shown, /52355/);
  assert.match(shown, /CRY v NFO/);
});

test("level half-time odds reject the game, as on the real card", async () => {
  const app = await drive({ [LIST]: feed.page(feed.card), [P2]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /<b>0<\/b> matched/);
  assert.match(app.out.children.map((c) => c.textContent).join(""), /None matched/);
});

test("an away favourite is screened by the same rules, mirrored", async () => {
  const mirrored = feed.event("99001", "CCC", "DDD", [4.10, 4.30, 1.90], [2.05, 1.26, 1.29], [5.00, 2.70, 2.10]);
  const app = await drive({ [LIST]: feed.page([mirrored]), [P2]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /<b>1<\/b> matched/);
  assert.match(app.out.children.map((c) => c.innerHTML).join(""), /99001/);
});

test("walks on to page 2 and keeps going while new games appear", async () => {
  const extra = feed.event("52360", "AAA", "BBB", [1.80, 4.40, 3.95], [1.28, 1.24, 2.08], [2.20, 2.60, 4.60]);
  const P3 = LIST.replace("pageNum=1", "pageNum=3");
  const app = await drive(
    { [LIST]: feed.page(feed.card), [P2]: feed.page([extra]), [P3]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /Went through <b>5<\/b> games/);
  assert.match(app.out.children.map((c) => c.innerHTML).join(""), /52360/);
});

test("double chance is derived when the feed omits it", async () => {
  const noDC = feed.event("52361", "EEE", "FFF", [1.80, 4.40, 3.95], null, [2.20, 2.60, 4.60]);
  const app = await drive({ [LIST]: feed.page([noDC]), [P2]: feed.page([]) }, LIST);
  assert.match(app.count.innerHTML, /<b>1<\/b> matched/);
  assert.match(app.out.children.map((c) => c.innerHTML).join(""), /1\.28/);  // derived 1X
});

test("a game with no half-time odds is held, not silently dropped", async () => {
  const noHT = feed.event("52362", "GGG", "HHH", [1.80, 4.40, 3.95], [1.28, 1.24, 2.08], null);
  const app = await drive({ [LIST]: feed.page([noHT]), [P2]: feed.page([]) }, LIST);
  const shown = app.out.children.map((c) => c.innerHTML).join("");
  assert.match(shown, /52362/);
  assert.match(shown, /no half-time odds/);
});

test("an endpoint that ignores the page parameter does not loop", async () => {
  // Every page returns the same card; without the signature guard the sweep
  // would keep walking to pageNum=40.
  const routes = {};
  for (let n = 1; n <= 8; n++) routes[LIST.replace("pageNum=1", "pageNum=" + n)] = feed.page(feed.card);
  const app = await drive(routes, LIST);
  assert.match(app.count.innerHTML, /Went through <b>4<\/b> games/);
  const paged = app.calls.filter((u) => u.includes("pageNum") && u !== LIST);
  assert.ok(paged.length <= 3, "expected the sweep to stop quickly, it made " + paged.length + " page calls");
});

test("an empty card asks the user to open the list rather than claiming zero", async () => {
  const app = await drive({ [LIST]: { data: {} } }, LIST);
  assert.match(app.count.innerHTML, /Nothing found/);
  assert.match(app.out.children.map((c) => c.innerHTML + c.textContent).join(""), /Could not see the card/);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok   " + name); }
    catch (e) { failed++; console.log("  FAIL " + name + "\n       " + e.message); }
  }
  console.log("\n" + (tests.length - failed) + "/" + tests.length + " passed");
  process.exit(failed ? 1 : 0);
})();
