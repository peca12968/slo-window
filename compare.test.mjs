import assert from "node:assert/strict";
import test from "node:test";
import { compare } from "./compare.mjs";

const snap = (...resources) => ({ page: "https://example.test/", resources });
const item = (name, transferSize, extra) => ({ name, transferSize, encodedBodySize: 0, decodedBodySize: 0, ...extra });

test("groups repeated URLs, keeps queries distinct, tracks added and removed URLs", () => {
  const before = snap(item("/a#one", 310), item("/a#two", 0, { deliveryType: "cache" }), item("/a?lang=zh", 305));
  const after = snap(item("https://example.test/a", 300), item("/new", 333), item("data:,test", 0));
  const result = compare(before, after);
  assert.deepEqual(result.resources.map(row => row.transferDelta), [-10, -305, 333]);
  assert.equal(result.before.cacheDeliveries, 1);
  assert.equal(result.before.requests, 3);
  assert.equal(result.transferDelta, 18);
});

test("body visibility alone cannot establish that a zero transfer is observable", () => {
  const mixed = snap(item("/a", 41), item("/a", 0, { decodedBodySize: 20 }));
  const result = compare(mixed, snap(item("/a", 0, { requestStart: 1 })));
  assert.equal(result.before.reportedTransfer, 41);
  assert.equal(result.before.unknown, 1);
  assert.equal(result.after.unknown, 0);
  assert.equal(result.resources[0].transferDelta, null);
});

test("rejects invalid or missing required fields", () => {
  for (const size of [-1, 1.5, undefined]) assert.throws(() => compare(snap(item("/x", size)), snap()), /transferSize/);
  assert.throws(() => compare({}, snap()), /resources/);
});
