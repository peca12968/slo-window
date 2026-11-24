import { readFile } from "node:fs/promises";

function index(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.resources)) throw new Error("Expected a resources array");
  const base = new URL(snapshot.page);
  const totals = new Map();
  for (const entry of snapshot.resources) {
    if (!entry || typeof entry.name !== "string" || !entry.name) throw new Error("Expected a resource URL");
    const url = new URL(entry.name, base);
    if (!["http:", "https:"].includes(url.protocol)) continue;
    url.hash = "";
    for (const key of ["transferSize", "encodedBodySize", "decodedBodySize"]) {
      if (!Number.isSafeInteger(entry[key]) || entry[key] < 0) throw new Error(`Invalid ${key} for ${url}`);
    }
    const key = url.href;
    const totalsForUrl = totals.get(key) ?? { requests: 0, reportedTransfer: 0, unknown: 0, cacheDeliveries: 0 };
    totalsForUrl.requests++;
    totalsForUrl.reportedTransfer += entry.transferSize;
    if (entry.deliveryType === "cache") totalsForUrl.cacheDeliveries++;
    // A zeroed entry may conceal a cross-origin fetch. Use positive restricted
    // fields or an explicit cache signal as evidence before treating zero as observed.
    if (entry.transferSize === 0 && entry.deliveryType !== "cache" && !(entry.requestStart > 0) &&
        !(entry.responseStart > 0)) totalsForUrl.unknown++;
    totals.set(key, totalsForUrl);
  }
  return totals;
}

function summary(values) {
  const total = { requests: 0, reportedTransfer: 0, unknown: 0, cacheDeliveries: 0 };
  for (const value of values) {
    for (const key of Object.keys(total)) total[key] += value[key];
  }
  return total;
}

function diff(before, after) {
  return { before, after, transferDelta: before.unknown || after.unknown ? null : after.reportedTransfer - before.reportedTransfer };
}

export function compare(before, after) {
  const left = index(before);
  const right = index(after);
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  const resources = keys.map(url => ({ url, ...diff(left.get(url) ?? summary([]), right.get(url) ?? summary([])) }));
  return { ...diff(summary(left.values()), summary(right.values())), resources };
}

if (import.meta.main) {
  try {
    const paths = process.argv.slice(2);
    if (paths.length !== 2) throw new Error("Usage: node compare.mjs before.json after.json");
    const snapshots = await Promise.all(paths.map(async path => JSON.parse(await readFile(path, "utf8"))));
    console.log(JSON.stringify(compare(...snapshots), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
