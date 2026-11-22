import { test, expect } from "@playwright/test";

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
