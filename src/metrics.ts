export type Sample = { date: string; requests: number; errors: number };
type RouteSample = Sample & { route: string };
type WindowDay = { date: string; sample?: Sample };
type Boundary = "window_edge" | "missing" | "zero_traffic" | "within_allowance";
type BurnState = "missing" | "zero_traffic" | "at_or_above" | "below";
type BurnStatus = "unknown" | "both" | "short_only" | "long_only" | "neither";
type BudgetPeriod = {
  start: string;
  end: string;
  days: number;
  requests: number;
  errors: number;
  excessScaled: bigint;
  before: Boundary;
  after: Boundary;
};
const day = 86_400_000;
const scale = 10_000n;

function budgetAllowance(requests: number, targetBps: number) {
  return BigInt(requests) * (scale - BigInt(targetBps));
}

export function budgetExcess(requests: number, errors: number, targetBps: number) {
  return BigInt(errors) * scale - budgetAllowance(requests, targetBps);
}

export function budgetOverruns(series: WindowDay[], targetBps: number) {
  const periods: BudgetPeriod[] = [];
  let current: Omit<BudgetPeriod, "after"> | undefined;
  let before: Boundary = "window_edge";
  let totalExcessScaled = 0n;
  for (const { date, sample } of series) {
    const excess = sample ? budgetExcess(sample.requests, sample.errors, targetBps) : 0n;
    if (sample && excess > 0n) {
      current ??= { start: date, end: date, days: 0, requests: 0, errors: 0, excessScaled: 0n, before };
      current.end = date;
      current.days++;
      current.requests += sample.requests;
      current.errors += sample.errors;
      current.excessScaled += excess;
      totalExcessScaled += excess;
      continue;
    }
    before = !sample ? "missing" : sample.requests === 0 ? "zero_traffic" : "within_allowance";
    if (current) periods.push({ ...current, after: before });
    current = undefined;
  }
  if (current) periods.push({ ...current, after: "window_edge" });
  periods.sort((a, b) => {
    if (a.excessScaled === b.excessScaled) return a.start.localeCompare(b.start);
    return a.excessScaled > b.excessScaled ? -1 : 1;
  });
  return { periods, totalExcessScaled };
}

function utcDay(value: string) {
  const time = Date.parse(value + "T00:00:00Z");
  return /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === value
    ? time
    : NaN;
}

function readCsv(text: string, allowRoutes: boolean) {
  const [header, ...lines] = text
    .replace(/^\uFEFF/, "")
    .trim()
    .split(/\r?\n/);
  const grouped = allowRoutes && header === "date,route,requests,errors";
  if (header !== "date,requests,errors" && !grouped)
    throw Error(allowRoutes ? "第一列必須為 date,requests,errors 或 date,route,requests,errors" : "第一列必須為 date,requests,errors");
  if (!lines.length || lines.length > 3660)
    throw Error(grouped ? "請提供 1 至 3660 筆路由統計" : "請提供 1 至 3660 天的資料");
  const seen = new Set<string>();
  const daily = new Map<string, Sample>();
  const entries = lines
    .map((line, index) => {
      const [date, ...fields] = line
        .split(",")
        .map((value) => value.trim());
      const route = grouped ? fields.shift() ?? "" : "";
      const [requests, errors, ...extra] = fields;
      if (!Number.isFinite(utcDay(date)) || (!grouped && seen.has(date)))
        throw Error(`第 ${index + 2} 列的日期無效或重複`);
      const key = grouped ? `${date}\n${route}` : date;
      if (grouped && (!route || route.length > 80 || /[\u0000-\u001f\u007f"]/.test(route) || seen.has(key)))
        throw Error(`第 ${index + 2} 列的路由無效或同日重複`);
      // The per-row ceiling and row limit keep all accepted totals within safe integers.
      const count = (value: string) => /^\d{1,12}$/.test(value);
      if (
        extra.length ||
        !count(requests) ||
        !count(errors) ||
        +errors > +requests
      )
        throw Error(`第 ${index + 2} 列的請求數或失敗數無效`);
      seen.add(key);
      const sample = daily.get(date) ?? { date, requests: 0, errors: 0 };
      sample.requests += +requests;
      sample.errors += +errors;
      daily.set(date, sample);
      return { date, route, requests: +requests, errors: +errors };
    });
  return { rows: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)), routes: grouped ? entries : null };
}

export function parseCsv(text: string): Sample[] {
  return readCsv(text, false).rows;
}

export function parseDataset(text: string) {
  return readCsv(text, true);
}

export function attributeBudget(rows: RouteSample[], series: WindowDay[], targetBps: number) {
  const dates = new Set(series.map(day => day.date));
  const totals = new Map<string, { route: string; requests: number; errors: number }>();
  for (const row of rows) {
    if (!dates.has(row.date)) continue;
    const route = totals.get(row.route) ?? { route: row.route, requests: 0, errors: 0 };
    route.requests += row.requests;
    route.errors += row.errors;
    totals.set(row.route, route);
  }
  const routes = [...totals.values()].map(route => ({
    ...route, excessScaled: budgetExcess(route.requests, route.errors, targetBps),
  })).sort((a, b) => a.excessScaled === b.excessScaled ? a.route.localeCompare(b.route, "en")
    : a.excessScaled > b.excessScaled ? -1 : 1);
  let excessScaled = 0n;
  let unusedScaled = 0n;
  for (const route of routes) {
    if (route.excessScaled > 0n) excessScaled += route.excessScaled;
    else unusedScaled -= route.excessScaled;
  }
  return { routes, excessScaled, unusedScaled, netScaled: excessScaled - unusedScaled };
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
  const allowance = budgetAllowance(requests, targetBps);
  const remaining = allowance - BigInt(errors) * scale;
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

export function compareBurnRates(
  rows: Sample[], targetBps: number, multiplier: number, endDate?: string,
) {
  if (!Number.isInteger(targetBps) || targetBps < 0 || targetBps >= Number(scale) ||
      !Number.isSafeInteger(multiplier) || multiplier < 1)
    throw Error("需要有效的可用率目標與消耗倍數");
  const end = windowEnd(rows, endDate);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const window = (days: number) => {
    const { series, requests, errors, coverage } = summarizeWindow(byDate, days, targetBps, end);
    const allowance = budgetAllowance(requests, targetBps);
    const spent = BigInt(errors) * scale;
    const state: BurnState = coverage < days ? "missing" : requests === 0 ? "zero_traffic"
      : spent >= allowance * BigInt(multiplier) ? "at_or_above" : "below";
    return { days, start: series[0].date, end: series[days - 1].date, coverage, requests, errors,
      ratio: coverage === days && allowance ? Number(spent) / Number(allowance) : null, state };
  };
  const short = window(2);
  const long = window(7);
  const status: BurnStatus = short.ratio === null || long.ratio === null ? "unknown"
    : short.state === "at_or_above" ? (long.state === "at_or_above" ? "both" : "short_only")
    : long.state === "at_or_above" ? "long_only" : "neither";
  return { short, long, status };
}
