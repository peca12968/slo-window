# Trace Time｜結帳追蹤時間分析

一筆結帳耗時 120 毫秒。庫存服務用了 60 毫秒，付款服務也用了 60 毫秒。兩者平行執行了多久？Trace Time 從 OpenTelemetry 的二進位匯出檔還原父子關係，算出每個 span 被直接子作業覆蓋的時間、重疊時間，以及未被子作業覆蓋的時間。

## 重現結帳請求

使用 Python 3.12 或 3.13。範例目錄附兩個合成請求的 OTLP/HTTP 本文，分別含結帳的根 span 與下游服務的三個 span。

```sh
python -m pip install -r requirements.txt
python trace_time.py examples/checkout.otlp examples/services.otlp
```

| 作業 | 相對開始與結束 | 與結帳的關係 |
| --- | --- | --- |
| checkout | 0–120 ms | 根作業 |
| reserve stock | 10–70 ms | 結帳呼叫庫存 |
| charge card | 40–100 ms | 結帳呼叫付款 |
| bank authorization | 50–80 ms | 付款呼叫銀行 |

結帳的兩個直接子作業從第 10 到第 100 毫秒合計覆蓋 **90 ms**，其中第 40 到第 70 毫秒有 **30 ms** 同時執行。結帳另有 **30 ms** 沒有被已觀測的直接子作業覆蓋，分別是起始的 10 ms 與尾端的 20 ms。銀行授權計入付款的子作業。要判定未覆蓋時間花在應用程式計算、等待，或缺少追蹤的呼叫，還需要其他觀測資料。

## 如何讀報表

每個 trace 依 ID 分組，span 依開始時間及 ID 排列。時間欄位保留整數奈秒。

| 欄位 | 在這個 span 的意義 |
| --- | --- |
| `duration_ns` | 從開始到結束的經過時間 |
| `covered_ns`、`uncovered_ns` | 至少有一個直接子作業的區間聯集長度，以及其餘時間 |
| `overlap_ns`、`peak_children` | 同時至少有兩個直接子作業的時間，以及同時執行數最高值。三個同時執行時，該段時間在 overlap 只計一次 |
| `child_time_outside_ns` | 逐一加總每個直接子作業落在父時間以外的長度，保留排查時鐘偏差或非同步作業的線索 |

工具將每個子區間裁到父區間內，再依開始與結束時間掃描。相鄰的區間端點可以相接。對於有 k 個直接子作業的 span，端點排序的時間複雜度是 O(k log k)。[分析實作](trace_time.py)

## 分批匯出、重送與資料缺口

同一次追蹤可跨多個輸入檔。任意調換範例的輸入順序會得到相同報表。再傳一次 `examples/services.otlp`，會顯示 `duplicate_spans: 3`，時間數字保持相同。重送比對使用 trace ID、span ID、父 ID、服務名、作業名、時間、連結目標及 SDK 回報的丟棄連結數。連結屬性與排列順序不參與比較。

只分析下游檔案時，`missing_parent_ids` 會列出缺少的結帳 span，仍可分析付款與銀行之間的關係。沒有缺少父 ID 的紀錄也可能漏掉尚未擷取的子作業。遇到同一 span 的分析欄位衝突、倒置時間、無效 ID 或父子循環時，CLI 以結束碼 2 結束，完整報表才會寫入 stdout。

輸入為未壓縮的 OTLP `ExportTraceServiceRequest` Protobuf 本文，每個檔案一個請求。分析會將觀測到的 span 保存在記憶體中，適合本機調查已擷取的批次。[OTLP 傳輸規格](https://opentelemetry.io/docs/specs/otlp/#otlphttp) · [Trace 訊息定義](https://github.com/open-telemetry/opentelemetry-proto/blob/main/opentelemetry/proto/trace/v1/trace.proto)

## 用 SDK 重新產生資料

### 查詢批次工作來自哪些追蹤

兩個生產者各自排入一件工作，另一條獨立追蹤稍後把它們合併處理。`flush batch` 在 OpenTelemetry span links 中記錄兩個來源的 trace ID 與 span ID。以三個實際 OTLP/HTTP 匯出檔重現：

```sh
python trace_time.py --links examples/batch.otlp examples/enqueue-b.otlp examples/enqueue-a.otlp
```

報告顯示批次開始時，距離 A 結束已過 40 毫秒、距離 B 結束已過 15 毫秒。三條追蹤各有自己的根作業；連結不會增加子作業覆蓋時間。移除 B 的檔案重跑，該連結仍保留原始目標 ID，狀態為 `missing`，時間差為 null。[OpenTelemetry 連結規格](https://opentelemetry.io/docs/specs/otel/trace/api/#link)

同一來源多次連向同一目標時，`count` 保存連結次數；重送整個批次只會增加 `duplicate_spans`。缺少完整有效目標識別碼時，狀態為 `unaddressable`。`dropped_links` 加總各唯一 span 回報的捨棄數。時間差依原始時間戳計算，跨主機時鐘偏差或作業交錯都可能產生負值。

### 重新錄製

```sh
python -m pip install -r requirements-test.txt
python examples/capture.py build
python examples/capture.py build --batch
python trace_time.py build/checkout.otlp build/services.otlp
python -m unittest -v
```

產生器以 W3C Trace Context 把結帳的上游資訊傳給庫存與付款，並用官方 Python SDK 將追蹤送至本機臨時 HTTP 接收端。示範時間固定，重新產生時會取得新的 trace 與 span ID。[產生器](examples/capture.py)

八項測試涵蓋實際 HTTP 匯出、不同收件順序與重送、跨 trace 的相同 span ID、連結解析、缺漏父作業、無效報文及非同步子作業超出父區間。另以固定種子產生 500 組時間軸，逐奈秒計數，獨立核對所有時間指標。[測試](test_trace_time.py) · [CI](.github/workflows/ci.yml)

**履歷用語**　以 Python、OTLP Protobuf 與區間掃描分析跨服務追蹤，從分批及重送資料還原並行呼叫的時間覆蓋，透過官方 SDK 匯出與 500 組時間軸驗證重疊計算。

本專案使用 AI 輔助開發，結帳與付款資料為合成範例。
