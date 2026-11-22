# Access Log Rollup｜HTTP 日誌轉每日可靠度統計

把每行一筆 JSON 的 HTTP 請求日誌轉成 [SLO Window](https://github.com/peca12968/slo-window) 可直接匯入的 CSV。適合在面試時從原始請求一路展示到錯誤預算。C# / .NET 10，無第三方套件。

## 跑一次並看結果

```sh
dotnet build src -c Release
dotnet src/bin/Release/net10.0/access-rollup.dll examples/checkout.ndjson
```

範例含 5 筆合成請求。5 月 2 日台北時間 07:30 的 503 會歸入 **UTC 5 月 1 日**。輸出包含 3 個有觀測值的日期。5 月 3 日沒有資料，儀表板匯入後會標示這個缺口。

```csv
date,requests,errors
2026-05-01,2,1
2026-05-02,1,0
2026-05-04,2,1
```

直接將 [checkout.csv](examples/checkout.csv) 匯入 SLO Window，或用下列 Bash / PowerShell 7 指令產生同格式的檔案。正式管線應檢查程序結束碼後再發佈輸出檔。

```sh
dotnet src/bin/Release/net10.0/access-rollup.dll examples/checkout.ndjson > daily.csv
```

## 輪替日誌中的重複請求

兩份日誌共 7 行，其中兩個請求在輪替時重疊。執行下列指令，可比較逐行統計與依請求 ID 去重的結果。[第一份日誌](examples/rotation-1.ndjson) · [第二份日誌](examples/rotation-2.ndjson)

```sh
dotnet src/bin/Release/net10.0/access-rollup.dll examples/rotation-1.ndjson examples/rotation-2.ndjson
dotnet src/bin/Release/net10.0/access-rollup.dll --dedupe examples/rotation-1.ndjson examples/rotation-2.ndjson
```

| 模式 | 請求數 | 5xx 數 | 匯入 SLO Window 的可用率 |
| --- | ---: | ---: | ---: |
| 逐行計數 | 7 | 3 | 57.143% |
| 依請求 ID 去重 | 5 | 2 | 60.000% |

啟用 `--dedupe` 時，每筆都須有 `request_id`，最多 128 個 ASCII 英數字或 `-_.:`，區分大小寫。相同 ID 的時間點和狀態碼相同就只算一次，其他描述欄位不參與比對。時間點先換算時區，精度保留到 100 奈秒。同一 ID 若對應不同狀態碼或時間點，工具會列出兩個來源與各自行號並停止。此模式也會拒絕同一 JSON 物件內重複的欄名。

請將同一批報表的所有日誌放在同一次執行，並使用整批唯一的請求 ID。程式會保留每個唯一 ID 的觀測值直到批次結束，記憶體用量隨唯一請求數增加。檔案順序可互換，空的輪替檔也可參與。以 `-` 可在任一位置讀取一次標準輸入。

## 計數與資料品質

每行代表一筆請求。所有 100–599 狀態都算流量，只有 5xx 計入此範例的服務端失敗。時間必須含秒數與明確的 Z 或數字偏移，可含最多七位小數秒。輸入可亂序、含空白行，亦可由標準輸入串流。預設模式會逐行計數，適用於每筆請求只出現一次的來源，也支援原有的無 ID 日誌。

程式逐行讀取 UTF-8 並按 UTC 日期彙總，預設模式只保留每日計數和目前這一行。日期數和單日計數遵循儀表板的輸入上限。所有來源都驗證通過後才輸出 CSV。遇到 JSON 或欄位錯誤會回報來源和行號至 stderr 並回傳 2。

## 測試與履歷展示

完成 Release 建置後執行 `python -m unittest -v`，可從 CLI 驗證時區換日、5xx 分類、亂序、UTF-8、異常資料與錯誤輸出。[CI](.github/workflows/ci.yml) 在 Linux 與 Windows 執行相同案例。

**履歷用語**　以 C# 開發串流日誌彙總 CLI，將跨時區 HTTP 紀錄轉成每日可用率指標的輸入，並以跨平台整合測試驗證資料邊界和錯誤處理。

本專案為 AI 輔助開發的作品集示範。
