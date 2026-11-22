import type { comparePeriods } from "./metrics";

type Comparison = ReturnType<typeof comparePeriods>;
const count = new Intl.NumberFormat("zh-TW");
const signed = new Intl.NumberFormat("zh-TW", {
  minimumFractionDigits: 3,
  maximumFractionDigits: 3,
  signDisplay: "exceptZero",
});

export function PeriodComparison({ comparison }: { comparison: Comparison }) {
  const { current, previous, difference, fullCoverage } = comparison;
  const periods = [current, previous];
  return (
    <section className="panel comparison" aria-labelledby="comparison-title">
      <h2 id="comparison-title">與前期比較</h2>
      <p>
        {difference !== null
          ? `本期可用率較前期相差 ${signed.format(difference)} 個百分點。`
          : fullCoverage
            ? "至少一期的總請求數為零，無法計算可用率差距。"
            : "至少一期缺少日期，暫無完整區間的可用率差距。"}
      </p>
      <table aria-label="相鄰兩期統計">
        <thead>
          <tr>
            <th scope="col">指標</th>
            {periods.map((period, index) => (
              <th scope="col" key={index}>
                {index === 0 ? "本期" : "前期"}
                <span className="period-range">
                  {period.series[0].date} 至 {period.series.at(-1)?.date}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">觀測天數</th>
            {periods.map((p, i) => (
              <td key={i}>
                {p.coverage}/{p.series.length}
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">請求數</th>
            {periods.map((p, i) => (
              <td key={i}>{p.coverage ? count.format(p.requests) : "—"}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">失敗數</th>
            {periods.map((p, i) => (
              <td key={i}>{p.coverage ? count.format(p.errors) : "—"}</td>
            ))}
          </tr>
          <tr>
            <th scope="row">可用率</th>
            {periods.map((p, i) => (
              <td key={i}>
                {p.availability === null
                  ? "—"
                  : p.availability.toFixed(3) + "%"}
              </td>
            ))}
          </tr>
        </tbody>
      </table>
      {!fullCoverage && (
        <details>
          <summary>查看缺資料的日期</summary>
          {periods.map((p, i) => (
            <p key={i}>
              {i === 0 ? "本期" : "前期"}：
              {p.coverage === p.series.length
                ? "資料完整"
                : p.series
                    .filter((row) => !row.sample)
                    .map((row) => row.date)
                    .join("、")}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
