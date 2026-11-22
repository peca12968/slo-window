import { readFile } from "node:fs/promises";
import { Scheduler } from "./scheduler.ts";

function replay(input) {
  const scheduler = new Scheduler(input.quanta);
  if (!Array.isArray(input.events)) throw new Error("Expected events array");
  const totals = new Map(Object.keys(input.quanta).map(name => [
    name, { dispatched: 0, pending: 0, cost: 0n }
  ]));
  const batches = [];
  for (const [index, event] of input.events.entries()) {
    try {
      if (!event || typeof event !== "object" || Object.keys(event).length !== 1) {
        throw new Error("Expected exactly one enqueue or dispatch operation");
      }
      if (Object.hasOwn(event, "enqueue")) {
        const job = event.enqueue;
        scheduler.enqueue(job);
        totals.get(job.tenant).pending += 1;
      } else if (Number.isSafeInteger(event.dispatch) && event.dispatch >= 0) {
        const jobs = [];
        while (jobs.length < event.dispatch) {
          const job = scheduler.next();
          if (!job) break;
          jobs.push(job);
          const total = totals.get(job.tenant);
          total.dispatched += 1;
          total.pending -= 1;
          total.cost += BigInt(job.cost);
        }
        batches.push({ event: index + 1, jobs });
      } else {
        throw new Error("Expected enqueue or a nonnegative safe-integer dispatch count");
      }
    } catch (error) {
      throw new Error("Event " + (index + 1) + ": " + error.message);
    }
  }
  const tenants = Object.fromEntries(Array.from(totals, ([name, total]) => [
    name, { ...total, cost: total.cost.toString() }
  ]));
  return { batches, tenants };
}

try {
  if (process.argv.length !== 3) throw new Error("Usage: node replay.mjs TRACE.json");
  const input = JSON.parse(await readFile(process.argv[2], "utf8"));
  console.log(JSON.stringify(replay(input), null, 2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
