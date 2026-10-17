import { test } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL ||= "postgres://u:p@localhost/db";
const { formFlags, MIN_PRICED } = await import("../site/api/_tt_watch.js");

const now = Date.UTC(2026, 9, 17, 19, 0);
const g = (home, away, rh, ra, wh, wa, hoursAgo) =>
  ({ home, away, r_home: rh, r_away: ra, win_home: wh, win_away: wa, start_at: now - hoursAgo * 3600e3 });

test("formFlags counts priced games and catches today's slump", () => {
  const rows = [
    g("Sabuka, David", "Seeman, Jan", 3, 0, 1.73, 2.01, 3),   // 0-3 today as underdog
    g("Cmil, Marcel", "Dufek, Jakub", 2, 3, 1.5, 2.6, 2),       // lost today as favourite
    g("Cmil, Marcel", "Novy, Petr", 3, 1, 1.4, 2.9, 48),        // older win
    g("Holy, Jan", "Novy, Petr", 3, 0, 0, 0, 1),                // unpriced: ignored
  ];
  const f = formFlags(rows, now);
  assert.equal(f.get("JAN|SEEMAN").priced, 1);
  assert.match(f.get("JAN|SEEMAN").slump, /lost 0-3 to Sabuka today/);
  assert.match(f.get("CMIL|MARCEL").slump, /as the favourite \(@1.5\)/);
  assert.equal(f.get("CMIL|MARCEL").priced, 2);
  assert.equal(f.get("DAVID|SABUKA").slump, null);
  assert.equal(f.has("HOLY|JAN"), false);
  assert.ok(MIN_PRICED > 1);
});
