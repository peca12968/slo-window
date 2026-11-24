import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Scheduler } from "./scheduler.ts";

function runTrace(input) {
  const dir = mkdtempSync(join(tmpdir(), "fair-dispatch-"));
  try {
    const path = join(dir, "trace.json");
    writeFileSync(path, JSON.stringify(input));
    return spawnSync(process.execPath, ["replay.mjs", path], {
      cwd: import.meta.dirname, encoding: "utf8", timeout: 5000
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// This reference visits every round literally. Only small costs enter this comparison.
function literalRounds(quanta) {
  const ring = [];
  const queues = new Map(Object.keys(quanta).map(k => [k, []]));
  const credits = new Map(Object.keys(quanta).map(k => [k, 0]));
  function* dispatch() {
    while (true) {
      if (!ring.length) { yield undefined; continue; }
      const name = ring.shift();
      const queue = queues.get(name);
      let budget = credits.get(name) + quanta[name];
      while (queue.length && queue[0].cost <= budget) {
        const job = queue.shift();
        budget -= job.cost;
        const ended = !queue.length;
        if (ended) credits.set(name, 0);
        yield job;
        if (ended) break;
      }
      // A newly reactivated tenant was already appended by enqueue.
      if (queue.length && !ring.includes(name)) {
        credits.set(name, budget);
        ring.push(name);
      }
    }
  }
  const stream = dispatch();
  return {
    enqueue(job) {
      const queue = queues.get(job.tenant);
      if (!queue.length) ring.push(job.tenant);
      queue.push(job);
    },
    next() { return stream.next().value; }
  };
}

test("work is shared by cost while preserving FIFO within each tenant", () => {
  const cli = spawnSync(process.execPath, ["replay.mjs", "examples/render.json"], {
    cwd: import.meta.dirname, encoding: "utf8"
  });
  assert.equal(cli.status, 0, cli.stderr);
  const { batches, tenants } = JSON.parse(cli.stdout);
  assert.deepEqual(batches[0].jobs.map(j => j.id), [
    "film-01", "thumb-01", "thumb-02", "film-02", "thumb-03", "thumb-04", "film-03", "thumb-05", "thumb-06"
  ]);
  assert.deepEqual(tenants, {
    render: { dispatched: 3, pending: 1, cost: "12" },
    thumbnail: { dispatched: 6, pending: 1, cost: "6" }
  });
});

test("an empty tenant gives up unused credit and reenters at the tail", () => {
  const s = new Scheduler({ A: 10, B: 2 });
  const put = (tenant, id, cost) => s.enqueue({ tenant, id, cost });
  put("A", "small", 1);
  put("B", "first", 2);
  put("B", "second", 2);
  assert.equal(s.next().id, "small");
  put("A", "big", 18);
  assert.deepEqual([s.next().id, s.next().id, s.next().id], ["first", "second", "big"]);
  assert.equal(s.next(), undefined);
});

test("500 dynamic traces agree with a round-by-round generator", () => {
  let state = 31862;
  function pick(limit) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return Math.floor(state / 4294967296 * limit);
  }
  for (let run = 0; run < 500; run++) {
    const names = ["render", "preview", "export"];
    const quanta = Object.fromEntries(names.map(name => [name, pick(9) + 1]));
    const fast = new Scheduler(quanta);
    const slow = literalRounds(quanta);
    for (let step = 0; step < 90; step++) {
      if (pick(100) < 55) {
        const job = { tenant: names[pick(3)], id: String(step), cost: pick(33) + 1 };
        fast.enqueue(job);
        slow.enqueue(job);
      } else {
        assert.deepEqual(fast.next(), slow.next(), "trace " + run + " step " + step);
      }
    }
    let expected;
    do {
      expected = slow.next();
      assert.deepEqual(fast.next(), expected, "draining trace " + run);
    } while (expected);
  }
});

test("very large costs finish and total exactly across dispatch boundaries", () => {
  const cost = Number.MAX_SAFE_INTEGER;
  const input = { quanta: { big: 1, quick: 2 }, events: [
    { enqueue: { tenant: "big", id: "one", cost } }, { enqueue: { tenant: "quick", id: "small", cost: 2 } },
    { enqueue: { tenant: "big", id: "two", cost } }, { dispatch: 1 }, { dispatch: cost }, { dispatch: 1 }
  ] };
  const cli = runTrace(input);
  assert.equal(cli.status, 0, cli.error?.message ?? cli.stderr);
  const report = JSON.parse(cli.stdout);
  assert.deepEqual(report.batches.map(b => b.jobs.map(j => j.id)), [["small"], ["one", "two"], []]);
  assert.equal(report.tenants.big.cost, "18014398509481982");
});

test("every submitted job retains its original fields; invalid input leaves the queue intact", () => {
  const s = new Scheduler({ A: 2 });
  const job = { tenant: "A", id: "kept", cost: 3 };
  s.enqueue(job);
  job.cost = 0;
  job.id = "changed";
  for (const invalid of [job, { tenant: "unknown", id: "x", cost: 1 },
    { tenant: "A", id: "x", cost: 1.5 }, { tenant: "A", id: "", cost: 1 }]) {
    assert.throws(() => s.enqueue(invalid));
  }
  assert.deepEqual(s.next(), { tenant: "A", id: "kept", cost: 3 });
  assert.equal(s.next(), undefined);
});

test("invalid traces fail with no partial report and valid zero-dispatch leaves work queued", () => {
  for (const invalid of [0, 2.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new Scheduler({ A: invalid }));
  for (const event of [{ dispatch: -1 }, { enqueue: { tenant: "A", id: "bad", cost: 0 } },
    { dispatch: 1, enqueue: null }, {}]) {
    const cli = runTrace({ quanta: { A: 3 }, events: [{ dispatch: 1 }, event] });
    assert.notEqual(cli.status, 0);
    assert.match(cli.stderr, /Event 2/);
    assert.equal(cli.stdout, "");
  }
  const cli = runTrace({ quanta: { A: 3 }, events: [{ enqueue: { tenant: "A", id: "x", cost: 5 } }, { dispatch: 0 }] });
  assert.equal(JSON.parse(cli.stdout).tenants.A.pending, 1);
});
