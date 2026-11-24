import type { attributeBudget } from "./metrics";
import { formatBudgetAmount } from "./budget-format";

const count = new Intl.NumberFormat("zh-TW");

function balance(value: bigint) {
  if (value === 0n) return "收支相抵";
  return value > 0n ? `超額 ${formatBudgetAmount(value)} 筆` : `餘額 ${formatBudgetAmount(-value)} 筆`;
}

export function RouteBudget({ analysis, coverage, days }: {
  analysis: ReturnType<typeof attributeBudget>;
  coverage: number;
  days: number;
}) {
  const { routes, excessScaled, unusedScaled, netScaled } = analysis;
  return (
    <section className="panel comparison route-budget" aria-labelledby="route-budget-title">
      <h2 id="route-budget-title">路由錯誤預算</h2>
      {coverage < days && <p>觀測 {coverage}/{days} 天，路由分項按已觀測資料計算。</p>}
      {coverage > 0 ? (
        <>
          <p role="status">超額 {formatBudgetAmount(excessScaled)} 筆 · 餘額 {formatBudgetAmount(unusedScaled)} 筆 · {netScaled === 0n ? "收支相抵" : `淨${balance(netScaled)}`}</p>
          <table aria-label="各路由的錯誤預算">
            <thead><tr><th scope="col">路由</th><th scope="col">失敗／請求</th><th scope="col">預算差</th></tr></thead>
            <tbody>{routes.map(route => (
              <tr key={route.route}>
                <th scope="row">{route.route}</th>
                <td>{`${count.format(route.errors)}／${count.format(route.requests)}`}</td>
                <td>{route.requests ? balance(route.excessScaled) : "零請求"}</td>
              </tr>
            ))}</tbody>
          </table>
        </>
      ) : <p>本期缺少路由觀測資料。</p>}
    </section>
  );
}
