# Load Receipt｜頁面重開時，哪些資源真的少傳了？

值班看板重開後，瀏覽器顯示兩筆資源的傳輸量都是 0。一筆由本機快取供應，另一筆的伺服器仍送出了圖片。Load Receipt 比較兩次頁面的 Resource Timing 紀錄，逐個 URL 列出瀏覽器回報的差值，遇到缺乏量測證據的 0 則保留未知。

## 重跑冷、暖快取實驗

使用 Node.js 24.12 以上。在同一個 Chromium 使用者工作階段中，程式開啟兩個分頁，並以兩個本機 HTTP 服務的請求紀錄交叉核對。資料與圖片皆為測試素材。

```sh
npm ci
npx playwright install chromium
npm test
npm run demo
```

| 資源 | 第二次開啟時的伺服器紀錄 | 瀏覽器量測 |
| --- | --- | --- |
| 月台資料 | 未收到第二次請求 | 首次解壓後有 56,000 bytes，第二次由快取供應，回報傳輸量為 0 |
| 版本清單 | 收到帶 ETag 的請求，回覆 304，沒有回應本文 | 仍有重新驗證的傳輸量 |
| 跨來源圖片 | 兩次都傳回相同圖片 | 缺少計時授權，兩筆都回報 0，差值是 `null` |
| 跨來源對照組 | 同一張圖片，回應多了 `Timing-Allow-Origin` | 兩次都能量到正值，差值是 0 |

## 比較自己的兩次載入

在 Chromium 開發者工具的 Console 執行下列指令，把剪貼簿內容存成 `before.json`。重新載入同一網站，等到要觀察的資源載入後，再將第二次結果存成 `after.json`。

```js
copy(JSON.stringify({
  page: location.href,
  resources: performance.getEntriesByType("resource").map(entry => entry.toJSON())
}))
```

```sh
node compare.mjs before.json after.json
```

程式依完整 HTTP(S) URL 分組，保留查詢參數、忽略片段。同一資源要求多次會合併，僅出現在單側的資源也會列入。每組的 `reportedTransfer` 是可見欄位加總，`unknown` 計算缺乏計時或快取證據的零值筆數。任何一側含未知項目時，該組與全表的 `transferDelta` 都為 `null`；其他資源仍可單獨比較。

比較範圍限於提供的瀏覽器紀錄。計時緩衝區遺漏的資源、文件導覽和 Service Worker 內部的請求都會影響涵蓋率。瀏覽器用固定的表頭估值計算傳輸量，實際網路用量需要搭配其他量測。[W3C Resource Timing](https://www.w3.org/TR/resource-timing/)

本專案使用 AI 輔助開發。[瀏覽器與伺服器交叉驗證](browser.test.mjs) · [快照比較測試](compare.test.mjs)
