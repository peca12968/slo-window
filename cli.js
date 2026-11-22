import {setTimeout as delay} from "node:timers/promises";
import pg from "pg";
import {initialize, enqueue, claim, complete, inspect} from "./queue.js";

const usage = "node cli.js init | enqueue TEXT [--key KEY] | show UUID | work [--once]";
const [command, ...args] = process.argv.slice(2);
let stopping = false;
process.on("SIGINT", () => { stopping = true; });
process.on("SIGTERM", () => { stopping = true; });

async function run(db) {
  if (command === "init" && !args.length) {
    await initialize(db);
    return;
  }
  if (command === "enqueue" && (args.length === 1 || (args.length === 3 && args[1] === "--key"))) {
    console.log(await enqueue(db, args[0], 3, args[2]));
    return;
  }
  if (command === "show" && args.length === 1) {
    const job = await inspect(db, args[0]);
    if (!job) throw new Error("Unknown job");
    console.log(JSON.stringify(job));
    return;
  }
  if (command !== "work" || (args.length && !(args.length === 1 && args[0] === "--once")))
    throw new Error(usage);
  const once = args[0] === "--once";
  do {
    const job = await claim(db);
    if (job) {
      const text = job.payload.trim();
      const result = {words: text ? text.split(/\s+/u).length : 0, utf8_bytes: Buffer.byteLength(job.payload)};
      const saved = await complete(db, job, result);
      console.log(JSON.stringify({id: job.id, status: saved ? "done" : "lease_lost"}));
    } else if (!once && !stopping) {
      await delay(500);
    }
  } while (!once && !stopping);
}

if (!process.env.DATABASE_URL) {
  console.error("Set DATABASE_URL to the PostgreSQL connection string.");
  process.exitCode = 2;
} else {
  const db = new pg.Pool({connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000});
  try {
    await run(db);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.end();
  }
}
