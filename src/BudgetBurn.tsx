import type { compareBurnRates } from "./metrics";

const count = new Intl.NumberFormat("zh-TW");
const labels = {
  unknown: "資料不足，暫無雙區間判定",
  both: "兩個區間都達到門檻",
  short_only: "只有短期達到門檻",
  long_only: "只有長期達到門檻",
  neither: "兩個區間都低於門檻",
};
const windowLabels = {
  missing: "缺少觀測資料", zero_traffic: "沒有請求", at_or_above: "達到門檻", below: "低於門檻",
};

export function BudgetBurn({ report, multiplier, setMultiplier }: {
  report: ReturnType<typeof compareBurnRates>;
  multiplier: number;
  setMultiplier: (next: number) => void;
}) {
  return (
    <section className="panel comparison budget-burn" aria-labelledby="burn-title">
      <h2 id="burn-title">錯誤預算消耗比較</h2>
      <p>兩個區間用相同 UTC 截止日。實際失敗數除以容許失敗數，即為消耗倍數。</p>
      <label className="burn-control">
        消耗門檻
        <select value={multiplier} onChange={(e) => setMultiplier(Number(e.target.value))}>
          {[1, 2, 4].map(value => <option key={value} value={value}>{value} 倍</option>)}
        </select>
      </label>
      <p role="status"><strong>{labels[report.status]}</strong></p>
      <table aria-label="兩個區間的預算消耗">
        <thead><tr>
          <th scope="col">區間</th><th scope="col">觀測</th><th scope="col">失敗／請求</th><th scope="col">消耗</th>
        </tr></thead>
        <tbody>{[report.short, report.long].map(window => (
          <tr key={window.days}>
            <th scope="row">{window.days} 天<span className="period-range">{window.start} 至 {window.end}</span></th>
            <td>{window.coverage}/{window.days} 天</td>
            <td>{window.coverage ? `${count.format(window.errors)}／${count.format(window.requests)}` : "—"}</td>
            <td>{window.ratio === null ? "—" : `${window.ratio.toFixed(2)} 倍`}
              <span className="period-range">{windowLabels[window.state]}</span></td>
          </tr>
        ))}</tbody>
      </table>
    </section>
  );
}
