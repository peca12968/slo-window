import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test("changes target, imports a file, and preserves the last good report after a bad file", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "可用率總覽" })).toBeVisible();
  await page.getByLabel("觀測區間").selectOption("7");
  await page.getByLabel("可用率目標").selectOption("9950");
  const upload = page.getByLabel("選擇 CSV 檔案");
  await upload.setInputFiles({
    name: "checkout.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("date,requests,errors\n2026-02-01,1000,6"),
  });
  await expect(page.locator("article.hero").getByText("99.400%")).toBeVisible();
  await expect(page.getByText("資料不足，結論待確認 · 資料涵蓋 1/7 天")).toBeVisible();
  await page.getByText("查看逐日數值").click();
  await expect(page.getByRole("cell", { name: "0.600%" })).toBeVisible();
  await upload.setInputFiles({
    name: "bad.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("bad"),
  });
  await expect(page.getByRole("alert")).toContainText("第一列");
  await expect(page.getByText("checkout.csv")).toBeVisible();
});

test("compares overlapping and deduplicated log counts and preserves observation gaps", async ({ page }) => {
  // CI supplies both outputs from the same two rotated logs.
  const csv = process.env.CHECKOUT_ROLLUP_CSV
    ? readFileSync(process.env.CHECKOUT_ROLLUP_CSV)
    : Buffer.from("date,requests,errors\n2026-05-01,2,1\n2026-05-02,1,0\n2026-05-04,2,1\n");
  await page.goto("/");
  const upload = page.getByLabel("選擇 CSV 檔案");
  const raw = process.env.RAW_ROLLUP_CSV
    ? readFileSync(process.env.RAW_ROLLUP_CSV)
    : Buffer.from("date,requests,errors\n2026-05-01,3,2\n2026-05-02,2,0\n2026-05-04,2,1\n");
  await upload.setInputFiles({ name: "raw.csv", mimeType: "text/csv", buffer: raw });
  await expect(page.locator("article.hero").getByText("57.143%", { exact: true })).toBeVisible();
  await expect(page.getByText("共 7 筆請求")).toBeVisible();
  await upload.setInputFiles({
    name: "checkout.csv", mimeType: "text/csv", buffer: csv,
  });
  await expect(page.locator("article.hero").getByText("60.000%", { exact: true })).toBeVisible();
  await expect(page.getByText("資料不足，結論待確認 · 資料涵蓋 3/14 天")).toBeVisible();
  await expect(page.getByText("共 5 筆請求")).toBeVisible();
  await page.getByText("查看逐日數值").click();
  await expect(page.getByRole("row").filter({
    has: page.getByRole("cell", { name: "2026-05-03", exact: true }),
  })).toContainText("缺資料");
});

test("compares complete periods then identifies a missing day on mobile", async ({page}) => {
  await page.setViewportSize({width: 375, height: 812});
  await page.goto("/");
  await page.getByLabel("觀測區間").selectOption("7");
  const rows = Array.from({length: 14}, (_, i) =>
    `2026-05-${String(i + 1).padStart(2, "0")},100,${i < 7 ? 2 : 1}`);
  const upload = async (values: string[]) => {
    await page.getByLabel("選擇 CSV 檔案").setInputFiles({
      name: "periods.csv", mimeType: "text/csv",
      buffer: Buffer.from(["date,requests,errors", ...values].join("\n")),
    });
  };
  await upload(rows);
  const comparison = page.getByRole("region", {name: "與前期比較"});
  await expect(comparison).toContainText("+1.000 個百分點");
  const row = comparison.getByRole("row", {name: /^可用率/});
  await expect(row.getByRole("cell")).toHaveText(["99.000%", "98.000%"]);
  await upload(rows.slice(1));
  await expect(comparison).toContainText("至少一期缺少日期");
  await comparison.getByText("查看缺資料的日期").click();
  await expect(comparison.getByText("前期：2026-05-01", {exact:true})).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("retains an explicit UTC cutoff across imports and surfaces trailing gaps on mobile", async ({page}) => {
  await page.setViewportSize({width: 360, height: 850});
  await page.goto("/");
  const date = page.getByLabel("截止日（UTC）");
  const metrics = page.getByRole("region", {name: "區間指標"});
  await expect(date).toHaveValue("2026-05-14");
  await expect(metrics).toContainText("已達標 · 資料涵蓋 14/14 天");
  await date.fill("2026-05-17");
  await expect(metrics).toContainText("資料不足，結論待確認 · 資料涵蓋 11/14 天");
  await expect(metrics).toContainText("依已觀測資料估算");
  await page.getByText("查看逐日數值").click();
  await expect(page.getByRole("row").filter({
    has: page.getByRole("cell", {name: "2026-05-17", exact: true}),
  })).toContainText("缺資料");

  await page.getByLabel("選擇 CSV 檔案").setInputFiles({
    name: "later.csv", mimeType: "text/csv",
    buffer: Buffer.from("date,requests,errors\n2026-06-10,100,0"),
  });
  await expect(date).toHaveValue("2026-05-17");
  await expect(metrics).toContainText("本期無觀測資料");
  await page.getByRole("button", {name:"回到最新資料日"}).click();
  await expect(date).toHaveValue("2026-06-10");
  await expect(metrics).toContainText("共 100 筆請求");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("ranks budget overruns and splits what looks continuous when a CSV observation is missing", async ({page}) => {
  await page.setViewportSize({width: 360, height: 850});
  await page.goto("/");
  await page.getByLabel("觀測區間").selectOption("7");
  const overruns = page.getByRole("region", {name: "錯誤預算超額區段"});
  await expect(overruns).toContainText("1 段 · 合計超額 52.9 筆");
  await expect(overruns.getByRole("listitem")).toContainText("2026-05-10");
  await page.getByLabel("可用率目標").selectOption("9995");
  await expect(overruns).toContainText("1 段 · 合計超額 70.15 筆");
  await expect(overruns.getByRole("listitem")).toContainText("2026-05-08 至 2026-05-11");

  const sample = readFileSync(new URL("../src/sample.csv", import.meta.url), "utf8");
  await page.getByLabel("選擇 CSV 檔案").setInputFiles({name: "gap.csv", mimeType: "text/csv",
    buffer: Buffer.from(sample.replace(/^2026-05-09,[^\r\n]+\r?\n/m, ""))});
  await expect(overruns).toContainText("2 段 · 合計超額 68.25 筆");
  await expect(overruns.getByRole("listitem").nth(0)).toContainText("2026-05-10 至 2026-05-11");
  await expect(overruns.getByRole("listitem").nth(0)).toContainText("前方 缺資料");
  await expect(overruns.getByRole("listitem").nth(1)).toContainText("超額 0.1 筆");
  await expect(overruns.getByRole("listitem").nth(1)).toContainText("後方 缺資料");
  await page.getByLabel("截止日（UTC）").fill("2026-05-10");
  await expect(overruns.getByRole("listitem").nth(0)).toContainText("後方 觀測區間邊界");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("compares the short and long burn at the same cutoff on mobile", async ({page}) => {
  await page.setViewportSize({width: 360, height: 850});
  await page.goto("/");
  const cutoff = page.getByLabel("截止日（UTC）");
  const burn = page.getByRole("region", {name: "錯誤預算消耗比較"});
  const status = burn.getByRole("status");
  await cutoff.fill("2026-05-10");
  await expect(status).toHaveText("只有短期達到門檻");
  await expect(burn.getByRole("row").filter({hasText: "2 天"})).toContainText("2.32 倍");
  await page.getByLabel("可用率目標").selectOption("9995");
  await expect(status).toHaveText("兩個區間都達到門檻");
  await burn.getByLabel("消耗門檻").selectOption("4");
  await expect(status).toHaveText("只有短期達到門檻");
  await burn.getByLabel("消耗門檻").selectOption("2");
  await cutoff.fill("2026-05-12");
  await expect(status).toHaveText("只有長期達到門檻");
  await cutoff.fill("2026-05-17");
  await expect(status).toHaveText("資料不足，暫無雙區間判定");
  await expect(burn.getByRole("row").filter({hasText: "2 天"})).toContainText("缺少觀測資料");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("attributes net error budget to routes and preserves the report through an invalid import", async ({page}) => {
  await page.setViewportSize({width: 360, height: 850});
  await page.goto("/");
  const route = page.getByRole("region", {name: "路由錯誤預算"});
  const totals = page.getByRole("region", {name: "區間指標"});
  await expect(route).toHaveCount(0);
  await page.getByLabel("觀測區間").selectOption("7");
  await page.getByRole("button", {name: "載入路由示範"}).click();
  await expect(totals).toContainText("共 28,000 筆請求");
  await expect(totals).toContainText("99.896%");
  await expect(route.getByRole("status")).toHaveText("超額 17.5 筆 · 餘額 16.5 筆 · 淨超額 1 筆");
  await expect(route.getByRole("row").filter({hasText: "POST /checkout"})).toContainText("24／6,500");
  await page.getByLabel("可用率目標").selectOption("9995");
  await expect(route.getByRole("status")).toContainText("淨超額 15 筆");
  await page.getByLabel("截止日（UTC）").fill("2026-05-08");
  await expect(route).toContainText("觀測 6/7 天");
  await expect(route.getByRole("row").filter({hasText: "POST /checkout"})).toContainText("20／5,500");

  const upload = page.getByLabel("選擇 CSV 檔案");
  await upload.setInputFiles({name: "duplicate.csv", mimeType: "text/csv", buffer: Buffer.from(
    "date,route,requests,errors\n2026-05-08,GET /catalog,100,2\n2026-05-08,GET /catalog,0,0")});
  await expect(page.getByRole("alert")).toContainText("同日重複");
  await expect(route).toContainText("觀測 6/7 天");
  await upload.setInputFiles({name: "route.csv", mimeType: "text/csv", buffer: Buffer.from(
    "date,route,requests,errors\n2026-05-08,GET /catalog,100,2\n2026-05-08,GET /idle,0,0")});
  await expect(route.getByRole("row").filter({hasText: "GET /idle"})).toContainText("零請求");
  await expect(totals).toContainText("共 100 筆請求");
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await upload.setInputFiles({name: "total.csv", mimeType: "text/csv", buffer: Buffer.from("date,requests,errors\n2026-05-08,100,2")});
  await expect(route).toHaveCount(0);
  await expect(totals).toContainText("共 100 筆請求");
});
