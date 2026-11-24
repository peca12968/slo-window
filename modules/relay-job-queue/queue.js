import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";

export async function initialize(db) {
  await db.query(await readFile(new URL("./schema.sql", import.meta.url), "utf8"));
}

export async function enqueue(db, text, maxAttempts = 3, requestKey = null) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 65_536)
    throw new Error("Expected text of at most 65536 UTF-8 bytes");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10)
    throw new Error("Expected 1 to 10 attempts");
  if (requestKey !== null && (typeof requestKey !== "string" || !requestKey.length ||
      Buffer.byteLength(requestKey) > 256 || requestKey.includes("\0")))
    throw new Error("Expected a nonempty request key of at most 256 UTF-8 bytes without NUL");
  const {rows} = await db.query(
    `INSERT INTO relay_jobs (id, payload, max_attempts, request_key) VALUES ($1,$2,$3,$4)
     ON CONFLICT (request_key) WHERE request_key IS NOT NULL DO NOTHING RETURNING id`,
    [randomUUID(), text, maxAttempts, requestKey]
  );
  if (rows.length) return rows[0].id;
  // A separate READ COMMITTED statement can see the winning concurrent insert.
  const {rows: [existing]} = await db.query(
    "SELECT id, payload, max_attempts FROM relay_jobs WHERE request_key=$1", [requestKey]
  );
  if (!existing) throw new Error("The conflicting job disappeared; retry submission");
  if (existing.payload !== text || existing.max_attempts !== maxAttempts)
    throw new Error("Request key already used with a different payload or retry limit");
  return existing.id;
}

function validateLease(leaseMs) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
    throw new Error("Expected a lease of 1 to 3600000 milliseconds");
}

export async function claim(db, leaseMs = 30_000) {
  validateLease(leaseMs);
  // A final attempt can crash without reporting failure. Reap expired terminal leases in batches.
  await db.query(`
    WITH exhausted AS (
      SELECT id FROM relay_jobs
      WHERE state='running' AND lease_until <= statement_timestamp() AND attempts=max_attempts
      ORDER BY lease_until, id LIMIT 100 FOR UPDATE SKIP LOCKED
    )
    UPDATE relay_jobs j SET state='dead', last_error='Lease expired on final attempt',
                            lease_token=NULL, lease_until=NULL
    FROM exhausted WHERE j.id=exhausted.id`);
  const {rows} = await db.query(`
    WITH candidate AS (
      SELECT id FROM relay_jobs
      WHERE (state='ready' AND available_at <= statement_timestamp())
         OR (state='running' AND lease_until <= statement_timestamp() AND attempts < max_attempts)
      ORDER BY CASE WHEN state='running' THEN lease_until ELSE available_at END, id
      LIMIT 1 FOR UPDATE SKIP LOCKED
    )
    UPDATE relay_jobs j SET state='running', attempts=attempts+1, lease_token=$1,
                            lease_until=clock_timestamp()+$2::integer * interval '1 millisecond'
    FROM candidate WHERE j.id=candidate.id
    RETURNING j.id, payload, attempts, lease_token, lease_until`, [randomUUID(), leaseMs]);
  return rows[0] ?? null;
}

// The row lock may wait without the row changing. Sample the database clock
// after the lock is acquired so a request queued before expiry cannot revive it.
const checkOwner = `WITH locked AS MATERIALIZED (
  SELECT id, lease_until FROM relay_jobs
  WHERE id=$1 AND lease_token=$2 AND state='running' FOR UPDATE
), owner AS MATERIALIZED (
  SELECT id, lease_until, clock_timestamp() AS checked_at FROM locked
)`;
const owned = "FROM owner WHERE j.id=owner.id AND owner.lease_until>owner.checked_at";

export async function renew(db, job, leaseMs = 30_000) {
  validateLease(leaseMs);
  const {rows} = await db.query(`${checkOwner}
    UPDATE relay_jobs j
    SET lease_until=GREATEST(owner.lease_until, owner.checked_at + $3::integer * interval '1 millisecond')
    ${owned} RETURNING j.lease_until`, [job.id, job.lease_token, leaseMs]);
  return rows[0]?.lease_until ?? null;
}

export async function complete(db, job, result) {
  const update = await db.query(`${checkOwner}
    UPDATE relay_jobs j SET state='done', result=$3::jsonb, lease_token=NULL, lease_until=NULL,
                          last_error=NULL
    ${owned}`, [job.id, job.lease_token, JSON.stringify(result)]);
  return update.rowCount === 1;
}

export async function fail(db, job, message) {
  const {rows} = await db.query(`${checkOwner}
    UPDATE relay_jobs j
    SET state=CASE WHEN attempts=max_attempts THEN 'dead' ELSE 'ready' END,
        available_at=clock_timestamp() + (1 << (attempts-1)) * interval '1 second',
        lease_token=NULL, lease_until=NULL, last_error=$3
    ${owned} RETURNING state`, [job.id, job.lease_token, String(message).slice(0, 1000)]);
  return rows[0]?.state ?? null;
}

export async function inspect(db, id) {
  const {rows} = await db.query(`
    SELECT id, state, run_cycle, attempts, max_attempts, available_at, lease_until, result, last_error
    FROM relay_jobs WHERE id=$1`, [id]);
  return rows[0] ?? null;
}

export async function listDead(db, after = null) {
  const {rows} = await db.query(`
    SELECT id, run_cycle, attempts, last_error FROM relay_jobs
    WHERE state='dead' AND ($1::uuid IS NULL OR id > $1)
    ORDER BY id LIMIT 50`, [after]);
  return rows;
}

export async function redrive(db, id, cycle) {
  if (!Number.isInteger(cycle) || cycle < 1 || cycle >= 2_147_483_647)
    throw new Error("Expected a positive job cycle with room for a successor");
  // Only the reviewed terminal cycle may advance. Its receipt commits with the job update.
  const {rows} = await db.query(`
    WITH terminal AS MATERIALIZED (
      SELECT id, run_cycle, attempts, last_error FROM relay_jobs
      WHERE id=$1 AND state='dead' AND run_cycle=$2 FOR UPDATE
    ), restarted AS (
      UPDATE relay_jobs j SET state='ready', run_cycle=t.run_cycle+1, attempts=0,
                              last_error=NULL, available_at=clock_timestamp()
      FROM terminal t WHERE j.id=t.id
      RETURNING j.id, t.run_cycle, t.attempts, t.last_error
    )
    INSERT INTO relay_redrives(job_id, from_cycle, attempts, last_error)
    SELECT id, run_cycle, attempts, last_error FROM restarted
    RETURNING *`, [id, cycle]);
  if (rows.length) return rows[0];
  // A concurrent winner may have committed while this statement waited on its row lock.
  const receipt = await db.query("SELECT * FROM relay_redrives WHERE job_id=$1 AND from_cycle=$2", [id, cycle]);
  if (receipt.rowCount) return receipt.rows[0];
  throw new Error("No dead job at the requested cycle");
}
