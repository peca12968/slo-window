# Relay Job Queue｜可復原的背景工作佇列

工作者領取任務後突然中斷，誰來接手？舊工作者晚一步送回結果，又該接受哪一份？此專案以 PostgreSQL 保存工作、以租約限制寫入結果的權限，並提供可從終端機操作的 Node.js 文字統計工作者。

## 在本機跑第一筆工作

需要 Node.js 22 以上與 PostgreSQL 16 以上。附上的 Compose 可啟動僅監聽本機的示範資料庫。

```sh
docker compose up -d --wait
npm ci
```

在 PowerShell 設定 `$env:DATABASE_URL = "postgresql://relay:local-demo-only@127.0.0.1:55432/relay"`。Bash 使用 `export DATABASE_URL=postgresql://relay:local-demo-only@127.0.0.1:55432/relay`。然後執行：

```sh
node cli.js init
node cli.js enqueue "demo queue worker"
node cli.js work --once
```

將 enqueue 印出的 UUID 帶入 `node cli.js show UUID`。在新資料庫中，會看到狀態 done、嘗試次數 1，以及結果 `{"words":3,"utf8_bytes":17}`。範例依空白分詞。省略 `--once` 則會持續輪詢，Ctrl+C 讓工作者在當前工作結束後退出。

## 工作的生命週期

送件端若可能在網路逾時後重送，請為同一次操作產生穩定的鍵。可用下列指令連續送出兩次：

```sh
node cli.js enqueue "invoice 42" --key invoice-42
node cli.js enqueue "invoice 42" --key invoice-42
```

兩次應印出同一個工作 ID。12 個並行請求也只建立一筆工作；工作執行完後再重送，仍取得原 ID 與原結果。相同鍵若改變文字或最大嘗試次數，送件會失敗。未指定鍵時，每次都會建立新工作。鍵區分大小寫、上限 256 個 UTF-8 位元組，作用域為目前這張佇列表；不同業務來源可自行加上前綴。鍵跟工作列一同保存。

升級既有資料庫時先執行 `node cli.js init`。舊工作仍可領取，新加入的可空欄位與部分唯一索引只對有鍵的送件去重。

1. enqueue 賦予每筆工作不同的 UUID 並寫入 ready。多個工作者同時 claim 時，資料庫以 `FOR UPDATE SKIP LOCKED` 跳過已鎖定的候選工作。取得工作、增加嘗試次數、發出租約在同一個 SQL 敘述完成。
2. 預設租約為 30 秒，可由程式介面的 claim 指定長度。complete 與 fail 都比對工作 ID、該輪的隨機令牌及資料庫時鐘。租約到期，即使原工作者恢復也無法覆寫結果。
3. fail 依嘗試次數以 1、2、4 秒倍增延遲；到達上限則列為 dead。單純中斷時，下一次輪詢可在租約到期後接手。最後一次嘗試中斷時，下一次輪詢會把該筆工作列為 dead。maxAttempts 預設 3，可設定 1 至 10。
4. 同一工作可能執行多次。此範例只把統計結果寫回工作表，外部副作用應由實際處理器以工作 ID 做冪等控制。目前採固定租期，適合能在期限內完成的短工作。

## 如何驗證

指定測試用的 DATABASE_URL 後執行 `npm test`。測試使用隨機命名的獨立 schema，結束後清理。整合案例包括 12 個領取請求競爭 5 筆工作、跳過其他連線鎖住的工作、舊工作者遲到回報、重試耗盡、最後一次中斷，以及重新連線後讀回結果。測試用 SQL 推進特定工作期限，避免以長時間等待模擬故障。

[GitHub Actions](.github/workflows/ci.yml) 分別使用 PostgreSQL 16、17 啟動真實資料庫，並執行從 enqueue 到 show 的 CLI 示範。[工作生命週期實作](queue.js)與[並行整合測試](test/queue.test.js)可用於面試展示。

**履歷用語**　以 PostgreSQL 的列鎖及有期限的租約實作多工作者佇列，驗證中斷接手、過期寫入防護、指數退避與失敗工作的終止行為。

本專案為 AI 輔助開發的作品集示範。
