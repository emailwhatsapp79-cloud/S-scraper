/* Runs the userscript in a fake DOM and lets a test drive it end to end. */
const fs = require("fs"), vm = require("vm");

function fakeEl(tag) {
  return {
    tag, style: {}, dataset: {}, children: [], hidden: false, _text: "", _html: "", _on: {}, _q: {},
    classList: { _s: new Set(), add(c){this._s.add(c);}, remove(c){this._s.delete(c);}, toggle(c){this._s.has(c)?this._s.delete(c):this._s.add(c);} },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(n, f) { this._on[n] = f; },
    click() { if (this._on.click) this._on.click.call(this); },
    querySelector(sel) { return this._q[sel] || (this._q[sel] = fakeEl(sel)); },
    setAttribute() {}, removeAttribute() {},
    get textContent() { return this._text; }, set textContent(v) { this._text = v; this.children.length = 0; },
    get innerHTML() { return this._html; }, set innerHTML(v) { this._html = v; },
  };
}

/** routes: { url: object }  - anything not listed 404s. */
function boot(routes) {
  const doc = {
    readyState: "complete", head: fakeEl("head"), body: fakeEl("body"),
    createElement: (t) => fakeEl(t), addEventListener() {},
  };
  const calls = [];
  function serve(url) {
    calls.push(url);
    const hit = Object.prototype.hasOwnProperty.call(routes, url) ? routes[url] : null;
    const text = hit === null ? "" : JSON.stringify(hit);
    return Promise.resolve({
      ok: hit !== null, status: hit === null ? 404 : 200,
      clone: () => ({ text: () => Promise.resolve(text) }),
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(hit),
    });
  }
  const sandbox = {
    document: doc, console, URL, URLSearchParams, Promise, JSON, Math, Number, Date,
    parseFloat, isFinite, Object, Array, String, RegExp, Error, setTimeout,
    location: { href: "https://www.sportybet.com/ng/m/sport/vfootball", origin: "https://www.sportybet.com" },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    fetch: serve,
    XMLHttpRequest: function () {},
  };
  sandbox.window = sandbox;
  sandbox.XMLHttpRequest.prototype = { open() {}, send() {} };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(process.env.VFS_SRC || "web/sportybet-screener.user.js", "utf8"), sandbox);

  const panel = doc.body.children.find((c) => c.tag === "div");
  return {
    sandbox, calls, panel,
    opener: doc.body.children.find((c) => c.tag === "button"),
    find: panel.querySelector("#vfs-find"),
    count: panel.querySelector("#vfs-count"),
    out: panel.querySelector("#vfs-out"),
    /** Pretend the site itself fetched this URL, so the hook records it. */
    siteFetched: (url) => sandbox.fetch(url).then((r) => r.clone().text()),
  };
}
module.exports = { boot, fakeEl };
