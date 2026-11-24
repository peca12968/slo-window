import {after, before, beforeEach, test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {setTimeout as delay} from "node:timers/promises";
import pg from "pg";
import {initialize, enqueue, claim, complete, fail, inspect, renew, listDead, redrive} from "../queue.js";
import {workOne} from "../worker.js";

const schema = "relay_test_" + randomUUID().replaceAll("-", "");
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("Set DATABASE_URL to a PostgreSQL test database");
const admin = new pg.Pool({connectionString});
const db = new pg.Pool({connectionString, options: "-c search_path=" + schema + " -c statement_timeout=5000"});

before(async () => {
  await admin.query("CREATE SCHEMA " + schema);
  await initialize(db);
});
beforeEach(async () => {
  await db.query("TRUNCATE " + schema + ".relay_redrives, " + schema + ".relay_jobs");
});
after(async () => {
  await db.end();
  await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
  await admin.end();
});

const expire = id => db.query("UPDATE relay_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [id]);

test("twelve concurrent keyed submissions yield a single job and preserve its completed result", async () => {
  const ids = await Promise.all(Array.from({length: 12}, () => enqueue(db, "invoice 42", 3, "invoice-42")));
  assert.equal(new Set(ids).size, 1);
  const job = await claim(db);
  assert.equal(job.id, ids[0]);
  assert.equal(await claim(db), null);
  assert.equal(await complete(db, job, {words:2}), true);
  assert.equal(await enqueue(db, "invoice 42", 3, "invoice-42"), job.id);
  assert.deepEqual((await inspect(db, job.id)).result, {words:2});
  assert.equal(await claim(db), null);
});

test("conflicting concurrent inputs cannot overwrite the winner", async () => {
  const inputs = ["first", "second"];
  const results = await Promise.allSettled(inputs.map(text => enqueue(db, text, 3, "batch")));
  const winner = results.findIndex(result => result.status === "fulfilled");
  assert.notEqual(winner, -1);
  assert.match(results[1 - winner].reason.message, /different payload or retry limit/);
  const job = await claim(db);
  assert.equal(job.payload, inputs[winner]);
  await assert.rejects(enqueue(db, inputs[winner], 2, "batch"), /retry limit/);
});

test("independent submissions and invalid keys retain distinct semantics", async () => {
  const ids = await Promise.all([null, null, "A", "a"].map(key => enqueue(db, "same", 3, key)));
  assert.equal(new Set(ids).size, 4);
  for (const key of ["", "收".repeat(86), "broken\0key", 9])
    await assert.rejects(enqueue(db, "same", 3, key), /request key/);
});

test("initialization upgrades a legacy job without making it a keyed submission", async () => {
  // This schema belongs only to this test suite.
  await db.query("ALTER TABLE relay_jobs DROP COLUMN request_key");
  await db.query("DROP TABLE relay_redrives");
  await db.query("ALTER TABLE relay_jobs DROP COLUMN run_cycle");
  const id = randomUUID();
  await db.query("INSERT INTO relay_jobs(id,payload,max_attempts) VALUES ($1,'legacy',3)", [id]);
  await initialize(db);
  await initialize(db);
  const legacy = await claim(db);
  assert.equal(legacy.id, id);
  assert.equal((await inspect(db, id)).run_cycle, 1);
  const keyed = await enqueue(db, "legacy", 3, "import");
  assert.notEqual(keyed, id);
  assert.equal(await enqueue(db, "legacy", 3, "import"), keyed);
});

test("twelve concurrent workers claim each of five jobs once", async () => {
  const ids = await Promise.all(Array.from({length: 5}, (_, i) => enqueue(db, "payload" + i)));
  const leases = (await Promise.all(Array.from({length: 12}, () => claim(db)))).filter(Boolean);
  assert.deepEqual(leases.map(job => job.id).sort(), ids.sort());
  assert.ok(leases.every(job => job.attempts === 1));
});

test("a locked candidate does not stall another worker", async () => {
  const busy = await enqueue(db, "busy");
  const next = await enqueue(db, "next");
  const owner = await db.connect();
  try {
    await owner.query("BEGIN");
    await owner.query("SELECT id FROM relay_jobs WHERE id=$1 FOR UPDATE", [busy]);
    assert.equal((await claim(db)).id, next);
  } finally {
    await owner.query("ROLLBACK");
    owner.release();
  }
  assert.equal((await claim(db)).id, busy);
});

test("concurrent redrives restore one attempt budget and replay even after another dead cycle", async () => {
  const id = await enqueue(db, "weekly digest", 1, "digest-31");
  await assert.rejects(redrive(db, id, 1), /No dead job/);
  const old = await claim(db);
  await assert.rejects(redrive(db, id, 1), /No dead job/);
  assert.equal(await fail(db, old, "mailbox offline"), "dead");
  const receipts = await Promise.all(Array.from({length:12}, () => redrive(db, id, 1)));
  assert.ok(receipts.every(receipt => JSON.stringify(receipt) === JSON.stringify(receipts[0])));
  assert.equal(receipts[0].last_error, "mailbox offline");
  assert.equal(receipts[0].attempts, 1);
  assert.equal((await inspect(db, id)).attempts, 0);
  const leases = (await Promise.all(Array.from({length:8}, () => claim(db)))).filter(Boolean);
  assert.equal(leases.length, 1);
  assert.equal(leases[0].id, id);
  assert.equal(leases[0].attempts, 1);
  assert.equal(await complete(db, old, {late:true}), false);
  assert.equal(await fail(db, leases[0], "disk full"), "dead");
  assert.deepEqual(await redrive(db, id, 1), receipts[0]);
  const waiting = await listDead(db);
  assert.deepEqual(waiting, [{id, run_cycle:2, attempts:1, last_error:"disk full"}]);
  const next = await redrive(db, id, 2);
  assert.equal(next.last_error, "disk full");
  const final = await claim(db);
  assert.equal(await complete(db, final, {ok:true}), true);
  assert.deepEqual(await redrive(db, id, 2), next);
  assert.equal(await enqueue(db, "weekly digest", 1, "digest-31"), id);
  const saved = await inspect(db, id);
  assert.deepEqual([saved.run_cycle, saved.state, saved.result], [3, "done", {ok:true}]);
  assert.equal((await db.query("SELECT * FROM relay_redrives WHERE job_id=$1", [id])).rowCount, 2);
});

test("operator CLI lists a final expired lease then redrives and completes the original job", async () => {
  const url = new URL(connectionString);
  url.searchParams.set("options", "-c search_path=" + schema);
  const cli = async (...args) => {
    const file = fileURLToPath(new URL("../cli.js", import.meta.url));
    const {stdout} = await promisify(execFile)(process.execPath, [file, ...args],
      {env:{...process.env, DATABASE_URL:url.href}});
    return JSON.parse(stdout);
  };
  const id = await enqueue(db, "mail the digest", 1);
  await claim(db);
  await expire(id);
  assert.equal(await claim(db), null);
  const [dead] = await cli("dead");
  assert.equal(dead.last_error, "Lease expired on final attempt");
  const receipt = await cli("redrive", dead.id, "--cycle", String(dead.run_cycle));
  assert.deepEqual(await cli("redrive", id, "--cycle", "1"), receipt);
  assert.deepEqual(await cli("work", "--once"), {id, status:"done"});
  const saved = await cli("show", id);
  assert.deepEqual([saved.run_cycle, saved.result.words], [2, 3]);
  assert.deepEqual(await cli("dead"), []);
});

test("receipt write failure leaves the terminal job eligible for a later redrive", async () => {
  const id = await enqueue(db, "recover", 1);
  await fail(db, await claim(db), "temporarily unavailable");
  await db.query("ALTER TABLE relay_redrives ADD CONSTRAINT simulate_error CHECK (from_cycle <> 1)");
  try {
    await assert.rejects(redrive(db, id, 1), {code:"23514"});
    const job = await inspect(db, id);
    assert.deepEqual([job.state, job.run_cycle, job.attempts, job.last_error],
      ["dead", 1, 1, "temporarily unavailable"]);
    assert.equal(await claim(db), null);
  } finally {
    await db.query("ALTER TABLE relay_redrives DROP CONSTRAINT simulate_error");
  }
  assert.equal((await redrive(db, id, 1)).job_id, id);
});

test("dead listing paginates without duplicating rows and skips other states", async () => {
  await db.query(`INSERT INTO relay_jobs(id,payload,state,attempts,max_attempts)
                  SELECT gen_random_uuid(),'broken','dead',1,1 FROM generate_series(1,53)`);
  await enqueue(db, "healthy");
  const first = await listDead(db);
  const second = await listDead(db, first.at(-1).id);
  assert.deepEqual([first.length, second.length], [50, 3]);
  const ids = [...first, ...second].map(row => row.id);
  assert.deepEqual(ids, [...new Set(ids)].sort());
  assert.deepEqual(await listDead(db, ids.at(-1)), []);
});

test("a replacement worker fences out late success and failure messages", async () => {
  const id = await enqueue(db, "recover me");
  const first = await claim(db);
  await expire(id);
  assert.equal(await complete(db, first, {source:"old"}), false);
  const replacement = await claim(db);
  assert.equal(replacement.attempts, 2);
  assert.notEqual(replacement.lease_token, first.lease_token);
  assert.equal(await fail(db, first, "late failure"), null);
  assert.equal(await complete(db, first, {source:"old"}), false);
  assert.equal(await complete(db, replacement, {source:"new"}), true);
  assert.equal(await complete(db, replacement, {source:"again"}), false);
  assert.deepEqual((await inspect(db, id)).result, {source:"new"});
});

test("failures back off and exhaust the configured retry limit", async () => {
  const id = await enqueue(db, "retry me", 3);
  for (const attempt of [1, 2]) {
    const job = await claim(db);
    const before = (await db.query("SELECT clock_timestamp() AS t")).rows[0].t;
    assert.equal(await fail(db, job, "temporary"), "ready");
    const {rows} = await db.query("SELECT available_at, clock_timestamp() AS t FROM relay_jobs WHERE id=$1", [id]);
    const delayMs = 1000 * 2 ** (attempt - 1);
    assert.ok(rows[0].available_at.getTime() >= before.getTime() + delayMs);
    assert.ok(rows[0].available_at.getTime() <= rows[0].t.getTime() + delayMs);
    assert.equal(await claim(db), null);
    await db.query("UPDATE relay_jobs SET available_at=clock_timestamp() WHERE id=$1", [id]);
    assert.equal(job.attempts, attempt);
  }
  assert.equal(await fail(db, await claim(db), "permanent"), "dead");
  assert.equal(await claim(db), null);
  const job = await inspect(db, id);
  assert.equal(job.attempts, 3);
  assert.equal(job.last_error, "permanent");
});

test("a crash on the last attempt is moved to dead by the next poll", async () => {
  const id = await enqueue(db, "final attempt", 1);
  await claim(db);
  await expire(id);
  assert.equal(await claim(db), null);
  assert.equal((await inspect(db, id)).state, "dead");
});

test("a client reconnect observes committed results", async () => {
  const id = await enqueue(db, "durable");
  await complete(db, await claim(db), {words:1});
  const fresh = new pg.Client({connectionString, options: "-c search_path=" + schema});
  await fresh.connect();
  try {
    assert.equal((await inspect(fresh, id)).result.words, 1);
  } finally {
    await fresh.end();
  }
});

test("renew extends from database time without shortening or banking unused lease time", async () => {
  const id = await enqueue(db, "long job");
  const job = await claim(db, 10_000);
  assert.equal(+(await renew(db, job, 100)), +job.lease_until);
  const extended = await renew(db, job, 60_000);
  assert.ok(extended > job.lease_until);
  const repeated = await renew(db, job, 60_000);
  const now = (await db.query("SELECT clock_timestamp() AS t")).rows[0].t;
  assert.ok(repeated >= extended && +repeated <= +now + 60_000);
  assert.equal((await inspect(db, id)).attempts, 1);
  await assert.rejects(renew(db, job, 0), /lease/);
  assert.equal(await complete(db, job, {ok:true}), true);
  assert.equal(await renew(db, job), null);
});

test("renew, complete and fail recheck expiry after waiting on an unchanged locked row", async () => {
  const jobs = [];
  for (const text of ["renew", "complete", "fail"]) {
    await enqueue(db, text);
    jobs.push(await claim(db));
  }
  const locker = await db.connect();
  let operations;
  try {
    await db.query("UPDATE relay_jobs SET lease_until=clock_timestamp()+interval '1.5 seconds'");
    await locker.query("BEGIN");
    await locker.query("SELECT id FROM relay_jobs FOR UPDATE");
    operations = Promise.all([renew(db, jobs[0]), complete(db, jobs[1], {}), fail(db, jobs[2], "old")]);
    // Check that each real backend started before expiry and is blocked by this transaction.
    let blocked = 0;
    const timeout = Date.now() + 3000;
    while (blocked !== 3 && Date.now() < timeout) {
      const {rows} = await db.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE $1=ANY(pg_blocking_pids(pid)) AND query_start < (SELECT MIN(lease_until) FROM relay_jobs)`,
        [locker.processID]);
      blocked = rows[0].n;
      if (blocked !== 3) await delay(10);
    }
    assert.equal(blocked, 3);
    await locker.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM MAX(lease_until)-clock_timestamp())) + 0.02)
                        FROM relay_jobs`);
  } finally {
    await locker.query("ROLLBACK");
    locker.release();
  }
  assert.deepEqual(await operations, [null, false, null]);
  for (const job of jobs) assert.equal((await inspect(db, job.id)).state, "running");
});

test("a slow handler keeps attempt one beyond its original deadline", async () => {
  const id = await enqueue(db, "slow work", 1);
  const outcome = await workOne(db, async (job, signal) => {
    await db.query(`SELECT pg_sleep(GREATEST(0, EXTRACT(EPOCH FROM $1::timestamptz-clock_timestamp())) + 0.1)`,
                   [job.lease_until]);
    const current = await inspect(db, id);
    assert.ok(current.lease_until > job.lease_until);
    assert.equal(await claim(db), null);
    assert.equal(signal.aborted, false);
    return {attempt:job.attempts};
  }, {leaseMs:1500, heartbeatMs:100});
  assert.deepEqual(outcome, {id, status:"done"});
  const final = await inspect(db, id);
  assert.deepEqual([final.state, final.attempts, final.result], ["done", 1, {attempt:1}]);
});

test("after takeover the old handler receives an abort and its output cannot replace the winner", async () => {
  const id = await enqueue(db, "handoff");
  const outcome = await workOne(db, async (job, signal) => {
    await expire(id);
    const next = await claim(db);
    assert.equal(next.attempts, 2);
    assert.equal(await renew(db, job), null);
    assert.ok(await renew(db, next));
    if (!signal.aborted) await once(signal, "abort", {signal:AbortSignal.timeout(4000)});
    assert.equal(await complete(db, next, {worker:"replacement"}), true);
    return {worker:"old"};
  }, {leaseMs:2000, heartbeatMs:50});
  assert.deepEqual(outcome, {id, status:"lease_lost"});
  assert.deepEqual((await inspect(db, id)).result, {worker:"replacement"});
});

test("worker preserves idle, retry and terminal failure outcomes", async () => {
  await assert.rejects(workOne(db, () => {}, {leaseMs:20, heartbeatMs:20}), /heartbeat/);
  assert.equal(await workOne(db, () => "nothing"), null);
  const id = await enqueue(db, "bad input", 2);
  const handler = () => { throw new Error("cannot process"); };
  assert.deepEqual(await workOne(db, handler), {id, status:"ready"});
  await db.query("UPDATE relay_jobs SET available_at=clock_timestamp() WHERE id=$1", [id]);
  assert.deepEqual(await workOne(db, handler), {id, status:"dead"});
  assert.equal((await inspect(db, id)).last_error, "cannot process");
});

test("a database error during renewal aborts the handler without publishing a result", async () => {
  const id = await enqueue(db, "connection problem");
  const client = await db.connect();
  try {
    await assert.rejects(workOne(client, async (_job, signal) => {
      // Only this connection loses access to the queue. The inspection pool still sees it.
      await client.query("SET search_path TO pg_catalog");
      if (!signal.aborted) await once(signal, "abort", {signal:AbortSignal.timeout(4000)});
      return {unconfirmed:true};
    }, {leaseMs:2000, heartbeatMs:100}), {code:"42P01"});
    const row = await inspect(db, id);
    assert.equal(row.state, "running");
    assert.equal(row.result, null);
    await expire(id);
    assert.equal((await claim(db)).attempts, 2);
  } finally {
    client.release(true);
  }
});
