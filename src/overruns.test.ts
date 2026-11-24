import { expect, test } from "vitest";
import { budgetOverruns, parseCsv, summarize } from "./metrics";
import sample from "./sample.csv?raw";
import fixture from "../examples/budget-overruns.json?raw";

const csv = (rows: string) => parseCsv("date,requests,errors\n" + rows);

test("keeps gaps and zero traffic separate and ranks by exact aggregate budget excess", () => {
  const rows = csv([
    "2026-05-01,1000,2", "2026-05-02,1000,2", "2026-05-04,1000,10",
    "2026-05-05,0,0", "2026-05-06,1000,2", "2026-05-07,1000,1",
    "2026-05-08,1000,2", "2026-05-09,1000,40",
  ].join("\n"));
  const { series } = summarize(rows, 8, 9990, "2026-05-08");
  expect(budgetOverruns(series, 9990)).toEqual({ totalExcessScaled: 130_000n, periods: [
    { start: "2026-05-04", end: "2026-05-04", days: 1, requests: 1000, errors: 10,
      excessScaled: 90_000n, before: "missing", after: "zero_traffic" },
    { start: "2026-05-01", end: "2026-05-02", days: 2, requests: 2000, errors: 4,
      excessScaled: 20_000n, before: "window_edge", after: "missing" },
    { start: "2026-05-06", end: "2026-05-06", days: 1, requests: 1000, errors: 2,
      excessScaled: 10_000n, before: "zero_traffic", after: "within_allowance" },
    { start: "2026-05-08", end: "2026-05-08", days: 1, requests: 1000, errors: 2,
      excessScaled: 10_000n, before: "within_allowance", after: "window_edge" },
  ] });
});

test("detects the smallest scaled excess when floating products are equal", () => {
  const rows = csv("2026-05-01,950000000001,949905000001");
  const { series, requests, errors } = summarize(rows, 1, 1);
  expect(requests * 9999).toBe(errors * 10_000);
  expect(budgetOverruns(series, 1).totalExcessScaled).toBe(1n);
  expect(budgetOverruns(series, 0)).toEqual({ totalExcessScaled: 0n, periods: [] });
});

test("recreates the private site's three summaries from the dashboard's synthetic CSV", () => {
  const data = JSON.parse(fixture);
  const rows = parseCsv(sample);
  expect(data.map((row: { scenario: string }) => row.scenario)).toEqual(["base", "strict", "gap"]);
  for (const report of data) {
    const selected = report.scenario === "gap" ? rows.filter(row => row.date !== "2026-05-09") : rows;
    const window = summarize(selected, report.days, report.targetBps, report.cutoff);
    expect(report.coverage).toBe(window.coverage);
    const expected = budgetOverruns(window.series, report.targetBps);
    const transferable = JSON.parse(JSON.stringify(expected, (_, value) => typeof value === "bigint" ? String(value) : value));
    expect({ periods: report.periods, totalExcessScaled: report.totalExcessScaled }).toEqual(transferable);
  }
  expect(data.map((row: { totalExcessScaled: string }) => row.totalExcessScaled)).toEqual(["529000", "701500", "682500"]);
});
