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
4. 同一工作可能執行多次。此範例只把統計結果寫回工作表，外部副作用應由實際處理器以工作 ID 做冪等控制。

## 工作時間超過原租約

CLI 工作者透過 `workOne(db, handler, {leaseMs, heartbeatMs})` 領取一筆工作。預設租約為 30 秒，每 10 秒向資料庫續租一次。讀取端也可以直接呼叫 `renew(db, job, leaseMs)`，成功時取得資料庫確認的新期限，失去租約時取得 `null`。續租沿用同一枚令牌和嘗試次數，期限只會維持或往後推進。連續提早續租也只會延到本次資料庫時間加上租期。

| 可重現的情境 | 可觀察的結果 |
| --- | --- |
| 工作執行超過最初 1.5 秒租期，期間每 100 毫秒續租 | 超過原期限後，另一位工作者仍領不到該工作。原工作者在第 1 次嘗試完成 |
| 租約已過期，接手者領取第 2 次嘗試 | 原處理器的 AbortSignal 收到通知。即使它仍回傳結果，資料庫只保存接手者的結果 |
| 續租、完成與失敗請求在原期限前抵達，但被其他連線的列鎖擋住 | 放開鎖時租約已過期，三筆操作均被拒絕 |

設定測試用 `DATABASE_URL` 後可單獨重現前兩個情境。

```sh
node --test --test-name-pattern="slow handler|after takeover"
```

處理器的第二個參數是 AbortSignal，可傳給支援取消的 I/O。若資料庫在續租時出錯，工作者會通知處理器停止、放棄發佈結果，並回報錯誤。CLI 的資料庫連線與 SQL 敘述逾時均為 5 秒。續租需要 Node.js 事件迴圈能繼續運作，長時間的同步運算應移入其他執行緒或程序。[工作者實作](worker.js)

每次寫入先鎖定仍屬於該令牌的資料列，再以資料庫時鐘檢查期限。因此剛好跨越期限的鎖等待，也遵守與一般請求相同的所有權規則。[租約 SQL](queue.js) · [PostgreSQL 整合測試](test/queue.test.js)

## 修復故障後重新執行工作

假設寄送摘要的服務暫時故障，工作已耗盡嘗試次數。值班人員可以查看失敗原因，修復服務後重新排入原工作。升級既有資料庫時先執行 `node cli.js init`，既有工作的執行輪次從 1 開始。

```sh
node cli.js dead
node cli.js redrive UUID --cycle 1
node cli.js work --once
node cli.js show UUID
```

以清單中的工作 ID 取代 `UUID`，並帶入當時看到的 `run_cycle`。清單按 ID 排序，每次最多 50 筆。可把最後一筆 ID 帶入 `node cli.js dead AFTER_UUID` 讀取下一頁。清單反映查詢當時的狀態，重新掃描可看到後來進入 dead 的工作。

重新執行會保留原工作 ID、送件鍵、內容和嘗試上限，將新輪次的嘗試次數歸零。收據保存前一輪的嘗試次數、最後錯誤及重排時間。即使第二輪又失敗，重送第一輪的指令仍只取得第一張收據。要啟動第三輪，必須檢視第二輪並指定 `--cycle 2`。實際處理器可繼續使用同一個工作 ID 去重外部副作用。

整合測試讓 12 個重排請求同時處理同一筆 dead 工作，再讓 8 個工作者競爭領取。結果只有一張重排收據、一個工作者取得新租約，舊令牌寫入會遭拒。另一個測試令收據寫入失敗，驗證工作仍維持 dead，供修復後重試。在測試資料庫中可執行下列指令重現。[並行、回滾與 CLI 測試](test/queue.test.js)

```sh
node --test --test-name-pattern="redrive|operator CLI|dead listing"
```

## 如何驗證

指定測試用的 DATABASE_URL 後執行 `npm test`。測試使用隨機命名的獨立 schema，結束後清理。整合案例包括 12 個領取請求競爭 5 筆工作、跳過其他連線鎖住的工作、舊工作者遲到回報、重試耗盡、最後一次中斷，以及重新連線後讀回結果。測試用 SQL 推進特定工作期限，避免以長時間等待模擬故障。

[GitHub Actions](../../.github/workflows/system.yml) 分別使用 PostgreSQL 16、17 啟動真實資料庫，並執行從 enqueue 到 show 的 CLI 示範。[工作生命週期實作](queue.js)與[並行整合測試](test/queue.test.js)可用於面試展示。

**履歷用語**　以 PostgreSQL 的列鎖及有期限的租約實作多工作者佇列，驗證中斷接手、過期寫入防護、指數退避與失敗工作的終止行為。

本專案為 AI 輔助開發的作品集示範。
