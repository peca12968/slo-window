export type Sample = { date: string; requests: number; errors: number };
const day = 86_400_000;

export function parseCsv(text: string): Sample[] {
  const [header, ...lines] = text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  if (header !== 'date,requests,errors') throw Error('第一列必須為 date,requests,errors');
  if (!lines.length || lines.length > 3660) throw Error('請提供 1 至 3660 天的資料');
  const seen = new Set<string>();
  return lines.map((line, index) => {
    const [date, requests, errors, ...extra] = line.split(',').map(value => value.trim());
    const time = Date.parse(date + 'T00:00:00Z');
    const invalidDate = !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(time)
      || new Date(time).toISOString().slice(0, 10) !== date;
    if (invalidDate || seen.has(date)) throw Error(`第 ${index + 2} 列的日期無效或重複`);
    // The per-day ceiling keeps the sum of all accepted rows within JS safe integers.
    const count = (value: string) => /^\d{1,12}$/.test(value);
    if (extra.length || !count(requests) || !count(errors) || +errors > +requests)
      throw Error(`第 ${index + 2} 列的請求數或失敗數無效`);
    seen.add(date);
    return {date, requests: +requests, errors: +errors};
  }).sort((a, b) => a.date.localeCompare(b.date));
}

export function summarize(rows: Sample[], days: number, targetBps: number) {
  const end = Date.parse(rows[rows.length - 1].date + 'T00:00:00Z');
  const byDate = new Map(rows.map(row => [row.date, row]));
  const series = Array.from({length: days}, (_, index) => {
    const date = new Date(end - (days - 1 - index) * day).toISOString().slice(0, 10);
    return {date, sample: byDate.get(date)};
  });
  const requests = series.reduce((sum, row) => sum + (row.sample?.requests ?? 0), 0);
  const errors = series.reduce((sum, row) => sum + (row.sample?.errors ?? 0), 0);
  const allowance = requests * ((10_000 - targetBps) / 10_000);
  return {series, requests, errors, coverage: series.filter(row => row.sample).length,
    availability: requests ? (1 - errors / requests) * 100 : null,
    // Use integer units for the threshold comparison to avoid rounded display decisions.
    within: requests ? errors * 10_000 <= requests * (10_000 - targetBps) : null,
    budget: allowance ? (1 - errors / allowance) * 100 : null};
}
