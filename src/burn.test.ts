import { expect, test } from "vitest";
import { compareBurnRates, parseCsv } from "./metrics";
import sample from "./sample.csv?raw";
import fixture from "../examples/budget-burn.json?raw";

const rows = (errors: number, requests = 1000) => Array.from({ length: 7 }, (_, index) => ({
  date: `2026-05-0${index + 1}`, requests, errors,
}));

test("matches both windows exactly at the threshold and never rounds an answer up", () => {
  const data = rows(2);
  const exact = compareBurnRates(data, 9990, 2);
  expect(exact.status).toBe("both");
  expect([exact.short.ratio, exact.long.ratio]).toEqual([2, 2]);
  const close = rows(1_000_000_000, 500_000_000_000);
  close[6].errors--;
  const report = compareBurnRates(close, 9990, 2);
  expect(report.short.ratio?.toFixed(2)).toBe("2.00");
  expect(report.status).toBe("neither");
});

test("requires coverage, distinguishes zero traffic, and does not count future observations", () => {
  const data = rows(2);
  data.push({ date: "2026-05-08", requests: 1000, errors: 1000 });
  const gap = compareBurnRates(data.filter(row => row.date !== "2026-05-02"), 9990, 2, "2026-05-07");
  expect(gap).toMatchObject({ status: "unknown", short: { ratio: 2, state: "at_or_above" },
    long: { coverage: 6, state: "missing", ratio: null, errors: 12 } });
  const zero = compareBurnRates([...data.slice(0, 5), ...rows(0, 0).slice(5)], 9990, 2);
  expect(zero).toMatchObject({ status: "unknown", short: { coverage: 2, requests: 0, state: "zero_traffic", ratio: null },
    long: { coverage: 7, requests: 5000, state: "at_or_above", ratio: 2 } });
});

test("recreates each public demo scenario from the dashboard CSV", () => {
  const data = JSON.parse(fixture);
  const samples = parseCsv(sample);
  expect(data.map((row: { status: string }) => row.status)).toEqual(["short_only", "both", "long_only", "unknown"]);
  for (const { scenario, targetBps, multiplier, cutoff, ...report } of data) {
    expect(compareBurnRates(samples, targetBps, multiplier, cutoff), scenario).toEqual(report);
  }
});
