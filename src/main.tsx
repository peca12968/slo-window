import React, { useId, useState } from "react";
import { createRoot } from "react-dom/client";
import { parseCsv, comparePeriods } from "./metrics";
import { PeriodComparison } from "./PeriodComparison";
import sample from "./sample.csv?raw";
import sampleUrl from "./sample.csv?url";
import "./style.css";

const format = new Intl.NumberFormat("zh-TW");
function Dashboard() {
  const [rows, setRows] = useState(() => parseCsv(sample));
  const [source, setSource] = useState("結帳服務 · 示範資料");
  const [days, setDays] = useState(14);
  const [target, setTarget] = useState(9990);
  const [error, setError] = useState("");
  const field = useId();
  const comparison = comparePeriods(rows, days, target);
  const report = comparison.current;
  const dailyRate = (count: number, total: number) =>
    total ? (count / total) * 100 : 0;
  const threshold = (10000 - target) / 100;
  const peak =
    Math.max(
      threshold,
      ...report.series.map(({ sample }) =>
        sample ? dailyRate(sample.errors, sample.requests) : 0,
      ),
    ) * 1.15;
  const status =
    report.within === null ? "無請求" : report.within ? "已達標" : "未達標";
  return (
    <main>
      <header>
        <div className="brand">
          <i aria-hidden="true">∿</i> SLO Window
        </div>
        <span>服務可靠度</span>
      </header>
      <section className="intro">
        <div>
          <p className="source">{source}</p>
          <h1>可用率總覽</h1>
        </div>
        <div className="controls">
          <label>
            觀測區間
            <select value={days} onChange={(e) => setDays(+e.target.value)}>
              {[7, 14, 30].map((n) => (
                <option key={n} value={n}>
                  {n} 天
                </option>
              ))}
            </select>
          </label>
          <label>
            可用率目標
            <select value={target} onChange={(e) => setTarget(+e.target.value)}>
              {[9900, 9950, 9990, 9995].map((n) => (
                <option key={n} value={n}>
                  {n / 100}%
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
      <section className="metrics" aria-label="區間指標">
        <article className="hero">
          <h2>觀測可用率</h2>
          <strong>
            {report.availability?.toFixed(3) ?? "—"}
            {report.availability !== null && "%"}
          </strong>
          <span>
            {status} · 資料涵蓋 {report.coverage}/{days} 天
          </span>
        </article>
        <article>
          <h2>剩餘錯誤預算</h2>
          <strong>
            {report.budget?.toFixed(1) ?? "—"}
            {report.budget !== null && "%"}
          </strong>
          <span>低於 0% 表示預算已耗盡</span>
        </article>
        <article>
          <h2>失敗請求</h2>
          <strong>{format.format(report.errors)}</strong>
          <span>共 {format.format(report.requests)} 筆請求</span>
        </article>
      </section>
      <section className="panel">
        <h2>每日失敗率</h2>
        <p>虛線為目標容許值 {threshold.toFixed(2)}%。斜紋代表缺少資料。</p>
        <div className="plot" aria-hidden="true">
          <div
            className="limit"
            style={{ bottom: (threshold / peak) * 100 + "%" }}
          />
          {report.series.map(({ date, sample }) => {
            const rate = sample && dailyRate(sample.errors, sample.requests);
            return (
              <div
                className={"slot" + (sample ? "" : " missing")}
                key={date}
                title={date}
              >
                {sample && (
                  <div
                    className={(rate ?? 0) > threshold ? "bar over" : "bar"}
                    style={{ height: ((rate ?? 0) / peak) * 100 + "%" }}
                  />
                )}
              </div>
            );
          })}
        </div>
        <div className="axis">
          <span>{report.series[0].date}</span>
          <span>{rows.at(-1)?.date}</span>
        </div>
        <details>
          <summary>查看逐日數值</summary>
          <table>
            <thead>
              <tr>
                <th>日期</th>
                <th>請求數</th>
                <th>失敗數</th>
                <th>失敗率</th>
              </tr>
            </thead>
            <tbody>
              {report.series.map(({ date, sample }) => (
                <tr key={date}>
                  <td>{date}</td>
                  <td>{sample ? format.format(sample.requests) : "缺資料"}</td>
                  <td>{sample?.errors ?? "—"}</td>
                  <td>
                    {sample?.requests
                      ? dailyRate(sample.errors, sample.requests).toFixed(3) +
                        "%"
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
      <PeriodComparison comparison={comparison} />
      <section className="imports">
        <div>
          <h2>匯入每日統計</h2>
          <p>
            CSV 只在此瀏覽器讀取。
            <a href={sampleUrl} download="sample.csv">
              下載範例
            </a>
          </p>
        </div>
        <div>
          <label htmlFor={field}>選擇 CSV 檔案</label>
          <input
            id={field}
            type="file"
            accept=".csv,text/csv"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              try {
                if (file.size > 500_000) throw Error("檔案上限為 500 KB");
                const next = parseCsv(await file.text());
                setRows(next);
                setSource(file.name);
                setError("");
              } catch (err) {
                setError(err instanceof Error ? err.message : "檔案讀取失敗");
              }
            }}
          />
        </div>
      </section>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Dashboard />);
