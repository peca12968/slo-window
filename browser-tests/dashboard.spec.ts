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
  await expect(page.getByText("99.400%")).toBeVisible();
  await expect(page.getByText("未達標 · 資料涵蓋 1/7 天")).toBeVisible();
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

test("presents UTC rollup counts and preserves gaps in the observation window", async ({ page }) => {
  // CI supplies the C# producer's actual output. Local UI-only runs use its published example.
  const csv = process.env.CHECKOUT_ROLLUP_CSV
    ? readFileSync(process.env.CHECKOUT_ROLLUP_CSV)
    : Buffer.from("date,requests,errors\n2026-05-01,2,1\n2026-05-02,1,0\n2026-05-04,2,1\n");
  await page.goto("/");
  await page.getByLabel("選擇 CSV 檔案").setInputFiles({
    name: "checkout.csv", mimeType: "text/csv", buffer: csv,
  });
  await expect(page.getByText("60.000%", { exact: true })).toBeVisible();
  await expect(page.getByText("未達標 · 資料涵蓋 3/14 天")).toBeVisible();
  await expect(page.getByText("共 5 筆請求")).toBeVisible();
  await page.getByText("查看逐日數值").click();
  await expect(page.getByRole("row").filter({ hasText: "2026-05-03" })).toContainText("缺資料");
});
