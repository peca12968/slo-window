import assert from "node:assert/strict";
import test from "node:test";
import { captureDemo } from "./capture_demo.mjs";

test("shared Chromium cache, ETag revalidation and timing permission agree with two HTTP servers", async () => {
  const { cold, warm, report } = await captureDemo();
  const entry = (run, path) => run.snapshot.resources.find(e => new URL(e.name).pathname === path);
  const request = (run, path) => run.requests.find(e => e.path === path);
  const change = path => report.resources.find(row => new URL(row.url).pathname === path);
  assert.equal(cold.requests.length, 4);
  assert.equal(warm.requests.length, 3);
  const payload = entry(cold, "/payload");
  assert.equal(payload.decodedBodySize, 56000);
  assert.equal(payload.encodedBodySize, request(cold, "/payload").bodyBytes);
  assert.ok(payload.encodedBodySize < payload.decodedBodySize);
  assert.equal(request(warm, "/payload"), undefined);
  assert.equal(entry(warm, "/payload").transferSize, 0);
  assert.equal(change("/payload").transferDelta, -payload.transferSize);
  assert.deepEqual(request(warm, "/manifest"), { path: "/manifest", status: 304, bodyBytes: 0 });
  assert.ok(entry(warm, "/manifest").transferSize > 0);
  for (const run of [cold, warm]) {
    assert.equal(request(run, "/manifest").status, run === cold ? 200 : 304);
    const hidden = request(run, "/foreign.png");
    assert.ok(hidden.bodyBytes > 0);
    assert.equal(hidden.bodyBytes, request(run, "/shared.png").bodyBytes);
    assert.equal(entry(run, "/foreign.png").transferSize, 0);
    assert.ok(entry(run, "/shared.png").transferSize >= hidden.bodyBytes);
  }
  assert.equal(change("/foreign.png").transferDelta, null);
  assert.equal(change("/shared.png").transferDelta, 0);
  assert.equal(report.before.unknown, 1);
  assert.equal(report.after.unknown, 1);
  assert.equal(report.transferDelta, null);
});
