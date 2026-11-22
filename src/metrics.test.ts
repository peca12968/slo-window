import { expect, test } from "vitest";
import { comparePeriods, parseCsv, summarize } from "./metrics";
const csv = (rows: string) => parseCsv("date,requests,errors\n" + rows);
test("weights by requests and keeps missing calendar days explicit", () => {
  const r = summarize(csv("2026-02-03,900,0\n2026-02-01,100,10"), 3, 9900);
  expect(r.availability).toBe(99);
  expect(r.within).toBe(true);
  expect(r.budget).toBe(0);
  expect(r.coverage).toBe(2);
  expect(r.series[1].sample).toBeUndefined();
});
test("limits the window and handles observed zero traffic", () => {
  const r = summarize(csv("2026-01-01,50,50\n2026-02-01,0,0"), 7, 9990);
  expect(r.coverage).toBe(1);
  expect(r.availability).toBeNull();
  expect(r.budget).toBeNull();
  expect(r.within).toBeNull();
});
test.each([
  "2026-02-30,1,0",
  "2026-02-01,1,2",
  "2026-02-01,1,-1",
  "2026-02-01,1,0\n2026-02-01,1,0",
  "2026-02-01,1,0,9",
])("rejects invalid input %s", (row) => {
  expect(() => csv(row)).toThrow();
});

test("uses adjacent UTC windows across leap day and weights each period by requests", () => {
  const rows = csv(
    "2024-02-27,100,100\n2024-02-28,90,0\n2024-02-29,10,10\n2024-03-01,900,0\n2024-03-02,100,1",
  );
  const { current, previous, difference } = comparePeriods(rows, 2, 9990);
  expect(previous.series.map((row) => row.date)).toEqual([
    "2024-02-28",
    "2024-02-29",
  ]);
  expect(current.series.map((row) => row.date)).toEqual([
    "2024-03-01",
    "2024-03-02",
  ]);
  expect(previous.availability).toBe(90);
  expect(current.availability).toBeCloseTo(99.9);
  expect(difference).toBeCloseTo(9.9);
});

test("incomplete coverage suppresses the difference even if both windows carried traffic", () => {
  const r = comparePeriods(
    csv("2026-01-02,100,2\n2026-01-03,100,1\n2026-01-04,100,0"),
    2,
    9900,
  );
  expect(r.previous.coverage).toBe(1);
  expect(r.previous.requests).toBe(100);
  expect(r.difference).toBeNull();
});

test("observed zero traffic keeps full coverage but has no comparable rate", () => {
  const r = comparePeriods(csv("2025-12-31,0,0\n2026-01-01,1,0"), 1, 9990);
  expect(r.fullCoverage).toBe(true);
  expect(r.previous.availability).toBeNull();
  expect(r.difference).toBeNull();
});

test("reports declines in percentage points independently of the selected SLO target", () => {
  const rows = csv("2026-01-01,100,1\n2026-01-02,100,2");
  for (const target of [9900, 9995]) {
    expect(comparePeriods(rows, 1, target).difference).toBeCloseTo(-1);
  }
});
