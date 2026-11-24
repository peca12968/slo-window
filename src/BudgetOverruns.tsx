import type { budgetOverruns } from "./metrics";

const numbers = new Intl.NumberFormat("zh-TW");
const boundary = {
  window_edge: "觀測區間邊界",
  missing: "缺資料",
  zero_traffic: "零請求",
  within_allowance: "在每日容許值內",
};

function formatExcess(scaled: bigint) {
  const whole = numbers.format(scaled / 10_000n);
  const fraction = String(scaled % 10_000n).padStart(4, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function BudgetOverruns({ analysis, coverage, days }: {
  analysis: ReturnType<typeof budgetOverruns>;
  coverage: number;
  days: number;
}) {
  const { periods, totalExcessScaled } = analysis;
  return (
    <section className="panel overruns" aria-labelledby="overruns-title">
      <h2 id="overruns-title">錯誤預算超額區段</h2>
      <p>連續超過每日容許值的 UTC 日期合為一段，按超額由大到小排列。</p>
      {coverage < days && <p className="overrun-note">有 {days - coverage} 天缺少資料，區段依已觀測日期列出。</p>}
      {periods.length ? (
        <>
          <p className="overrun-total">{periods.length} 段 · 合計超額 <strong>{formatExcess(totalExcessScaled)}</strong> 筆</p>
          <ol>
            {periods.map(period => (
              <li key={period.start}>
                <div className="overrun-heading">
                  <strong>{period.start}{period.start !== period.end && ` 至 ${period.end}`}</strong>
                  <span>超額 {formatExcess(period.excessScaled)} 筆</span>
                </div>
                <p>{period.days} 天 · {numbers.format(period.errors)} 筆失敗／{numbers.format(period.requests)} 筆請求</p>
                <small>前方 {boundary[period.before]} · 後方 {boundary[period.after]}</small>
              </li>
            ))}
          </ol>
        </>
      ) : <p>{coverage ? "已觀測日期沒有超額區段。" : "本期缺少觀測資料。"}</p>}
    </section>
  );
}
