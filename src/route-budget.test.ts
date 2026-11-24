import { expect, test } from "vitest";
import { attributeBudget, budgetExcess, parseCsv, parseDataset, summarize } from "./metrics";
import sample from "./sample-routes.csv?raw";
import fixture from "../examples/route-budget.json?raw";

const dataset = (rows: string) => parseDataset("date,route,requests,errors\n" + rows);

test("sums all routes into daily observations and scopes attribution to the same calendar window", () => {
  const input = dataset([
    "2026-05-04,/scheduled,50,50", "2026-05-01,/failure,700,9", "2026-05-01,/successful,300,0", "2026-05-03,/idle,0,0",
  ].join("\n"));
  expect(input.rows).toEqual([
    { date: "2026-05-01", requests: 1000, errors: 9 },
    { date: "2026-05-03", requests: 0, errors: 0 },
    { date: "2026-05-04", requests: 50, errors: 50 },
  ]);
  const window = summarize(input.rows, 3, 9990, "2026-05-03");
  expect(window.coverage).toBe(2);
  expect(window.within).toBeNull();
  const report = attributeBudget(input.routes!, window.series, 9990);
  expect(report).toEqual({
    routes: [
      { route: "/failure", requests: 700, errors: 9, excessScaled: 83_000n },
      { route: "/idle", requests: 0, errors: 0, excessScaled: 0n },
      { route: "/successful", requests: 300, errors: 0, excessScaled: -3000n },
    ], excessScaled: 83_000n, unusedScaled: 3000n, netScaled: 80_000n,
  });
  expect(report.netScaled).toBe(budgetExcess(window.requests, window.errors, 9990));
});

test("keeps both CSV formats separate and rejects ambiguous route rows", () => {
  const input = "date,requests,errors\n2026-05-01,100,1";
  expect(parseDataset(input)).toEqual({ rows: parseCsv(input), routes: null });
  for (const body of [
    "2026-05-01,/a,1,1\n2026-05-01, /a,0,0", "2026-05-01,,1,0", "2026-05-01,/a,1,2",
    '2026-05-01,"/a",1,0', "2026-05-01,/a,1,0,x", "2026-05-01,/a,1000000000000,0", "2026-02-30,/a,1,0",
  ]) expect(() => dataset(body)).toThrow();
});

test("finds an exact 0.0001 excess next to a much larger unused allowance", () => {
  const data = dataset("2026-05-01,/quarter,950000000001,949905000001\n2026-05-01,/reserve,3,0");
  const window = summarize(data.rows, 1, 1);
  const report = attributeBudget(data.routes!, window.series, 1);
  expect(report.excessScaled).toBe(1n);
  expect(report.unusedScaled).toBe(29_997n);
  expect(report.netScaled).toBe(-29_996n);
  expect(report.netScaled).toBe(budgetExcess(window.requests, window.errors, 1));
});

test("reproduces the site examples from the same route CSV loaded by the dashboard", () => {
  const data = parseDataset(sample);
  const scenarios = JSON.parse(fixture);
  expect(scenarios.map((row: { scenario: string }) => row.scenario)).toEqual(["base", "strict", "gap"]);
  expect(scenarios.map((row: { netScaled: string }) => row.netScaled)).toEqual(["10000", "150000", "10000"]);
  for (const { scenario, days, targetBps, cutoff, ...expected } of scenarios) {
    const window = summarize(data.rows, days, targetBps, cutoff);
    const analysis = attributeBudget(data.routes!, window.series, targetBps);
    const actual = { coverage: window.coverage, requests: window.requests, errors: window.errors, ...analysis };
    expect(JSON.parse(JSON.stringify(actual, (_, value) => typeof value === "bigint" ? String(value) : value))).toEqual(expected);
  }
});
