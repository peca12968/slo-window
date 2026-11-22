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

export async function claim(db, leaseMs = 30_000) {
  if (!Number.isInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000)
    throw new Error("Expected a lease of 1 to 3600000 milliseconds");
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

const owned = "id=$1 AND lease_token=$2 AND state='running' AND lease_until>clock_timestamp()";

export async function complete(db, job, result) {
  const update = await db.query(`
    UPDATE relay_jobs SET state='done', result=$3::jsonb, lease_token=NULL, lease_until=NULL,
                          last_error=NULL
    WHERE ${owned}`, [job.id, job.lease_token, JSON.stringify(result)]);
  return update.rowCount === 1;
}

export async function fail(db, job, message) {
  const {rows} = await db.query(`
    UPDATE relay_jobs
    SET state=CASE WHEN attempts=max_attempts THEN 'dead' ELSE 'ready' END,
        available_at=clock_timestamp() + (1 << (attempts-1)) * interval '1 second',
        lease_token=NULL, lease_until=NULL, last_error=$3
    WHERE ${owned} RETURNING state`, [job.id, job.lease_token, String(message).slice(0, 1000)]);
  return rows[0]?.state ?? null;
}

export async function inspect(db, id) {
  const {rows} = await db.query(`
    SELECT id, state, attempts, max_attempts, available_at, lease_until, result, last_error
    FROM relay_jobs WHERE id=$1`, [id]);
  return rows[0] ?? null;
}
