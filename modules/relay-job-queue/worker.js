import {setTimeout as delay} from "node:timers/promises";
import {claim, complete, fail, renew} from "./queue.js";

// Run one asynchronous handler. Stop scheduling heartbeats before finalization
// and wait for an already-issued renewal so it cannot outlive this invocation.
export async function workOne(db, handler, {
  leaseMs = 30_000, heartbeatMs = Math.max(1, Math.floor(leaseMs / 3))
} = {}) {
  if (typeof handler !== "function") throw new Error("Expected a job handler");
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs >= leaseMs)
    throw new Error("Expected a positive heartbeat interval shorter than the lease");
  const job = await claim(db, leaseMs);
  if (!job) return null;

  const stop = new AbortController();
  const ownership = new AbortController();
  let renewalError;
  async function heartbeat() {
    try {
      while (!stop.signal.aborted) {
        await delay(heartbeatMs, undefined, {signal: stop.signal});
        if (await renew(db, job, leaseMs) === null) {
          ownership.abort(new Error("Job lease lost"));
          return;
        }
      }
    } catch (error) {
      if (error.name === "AbortError" && stop.signal.aborted) return;
      renewalError = error;
      ownership.abort(error);
    }
  }
  const watching = heartbeat();
  let result;
  let failure;
  try {
    result = await handler(job, ownership.signal);
  } catch (error) {
    failure = String(error?.message ?? error);
  } finally {
    stop.abort();
    await watching;
  }
  if (renewalError) throw renewalError;
  if (ownership.signal.aborted) return {id: job.id, status: "lease_lost"};
  if (failure !== undefined)
    return {id: job.id, status: await fail(db, job, failure) ?? "lease_lost"};
  const saved = await complete(db, job, result);
  return {id: job.id, status: saved ? "done" : "lease_lost"};
}
