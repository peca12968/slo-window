import {after, before, beforeEach, test} from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import pg from "pg";
import {initialize, enqueue, claim, complete, fail, inspect} from "../queue.js";

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
  await db.query("TRUNCATE " + schema + ".relay_jobs");
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
  const id = randomUUID();
  await db.query("INSERT INTO relay_jobs(id,payload,max_attempts) VALUES ($1,'legacy',3)", [id]);
  await initialize(db);
  await initialize(db);
  const legacy = await claim(db);
  assert.equal(legacy.id, id);
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
