export type Sample = { date: string; requests: number; errors: number };
const day = 86_400_000;

function utcDay(value: string) {
  const time = Date.parse(value + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : NaN;
}

export function parseCsv(text: string): Sample[] {
  const [header, ...lines] = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  if (header !== "date,requests,errors")
    throw Error("第一列必須為 date,requests,errors");
  if (!lines.length || lines.length > 3660)
    throw Error("請提供 1 至 3660 天的資料");
  const seen = new Set<string>();
  return lines
    .map((line, index) => {
      const [date, requests, errors, ...extra] = line
        .split(",")
        .map((value) => value.trim());
      if (!Number.isFinite(utcDay(date)) || seen.has(date))
        throw Error(`第 ${index + 2} 列的日期無效或重複`);
      // The per-day ceiling keeps the sum of all accepted rows within JS safe integers.
      const count = (value: string) => /^\d{1,12}$/.test(value);
      if (
        extra.length ||
        !count(requests) ||
        !count(errors) ||
        +errors > +requests
      )
        throw Error(`第 ${index + 2} 列的請求數或失敗數無效`);
      seen.add(date);
      return { date, requests: +requests, errors: +errors };
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

function summarizeWindow(
  byDate: Map<string, Sample>,
  days: number,
  targetBps: number,
  end: number,
) {
  const series = Array.from({ length: days }, (_, index) => {
    const date = new Date(end - (days - 1 - index) * day)
      .toISOString()
      .split("T")[0];
    return { date, sample: byDate.get(date) };
  });
  const requests = series.reduce(
    (sum, row) => sum + (row.sample?.requests ?? 0),
    0,
  );
  const errors = series.reduce(
    (sum, row) => sum + (row.sample?.errors ?? 0),
    0,
  );
  const coverage = series.filter((row) => row.sample).length;
  // Scale the allowance and spend by 10,000 before comparing exact integers.
  const allowance = BigInt(requests) * BigInt(10_000 - targetBps);
  const remaining = allowance - BigInt(errors) * 10_000n;
  return {
    series,
    requests,
    errors,
    coverage,
    availability: requests ? (1 - errors / requests) * 100 : null,
    within: requests && coverage === days ? remaining >= 0n : null,
    budget: allowance ? (Number(remaining) / Number(allowance)) * 100 : null,
  };
}

function windowEnd(rows: Sample[], endDate?: string) {
  const end = utcDay(endDate ?? rows.at(-1)?.date ?? "");
  if (!Number.isFinite(end)) throw Error("請指定有效的 UTC 截止日");
  return end;
}

export function comparePeriods(
  rows: Sample[],
  days: number,
  targetBps: number,
  endDate?: string,
) {
  const end = windowEnd(rows, endDate);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const current = summarizeWindow(byDate, days, targetBps, end);
  const previous = summarizeWindow(byDate, days, targetBps, end - days * day);
  const fullCoverage = current.coverage === days && previous.coverage === days;
  const difference =
    fullCoverage &&
    current.availability !== null &&
    previous.availability !== null
      ? current.availability - previous.availability
      : null;
  return { current, previous, difference, fullCoverage };
}

export function summarize(rows: Sample[], days: number, targetBps: number, endDate?: string) {
  return summarizeWindow(
    new Map(rows.map((row) => [row.date, row])),
    days,
    targetBps,
    windowEnd(rows, endDate),
  );
}
