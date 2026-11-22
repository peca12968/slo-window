import { expect, test } from "vitest";
import { parseCsv, summarize } from "./metrics";
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
