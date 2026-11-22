# Pause Lens｜找出與 JVM 垃圾回收暫停重疊的請求

結帳服務有兩筆請求同時進行，期間 JVM 暫停一次。如果兩筆請求都涵蓋整段暫停，錄製時間軸只過了一段暫停時間，逐筆加總卻有兩份。Pause Lens 讀取 Java Flight Recorder（JFR）錄製檔，分別報告這兩種時間，並比較有、無重疊的請求延遲分布。

## 在本機錄製並分析

使用 JDK 21，在儲存庫根目錄執行：

```sh
javac PauseLens.java CaptureDemo.java
java -XX:+UseSerialGC CaptureDemo sample.jfr
java PauseLens sample.jfr demo.Request
```

示範產生四筆請求，讓兩個工作執行緒在請求開始後等待，待主執行緒要求 GC 並返回才結束。在一次本機錄製中，4 筆請求有 2 筆與暫停重疊，暫停的牆鐘時間為 6,341,500 ns，逐筆請求重疊合計為 12,683,000 ns。實際時間與 GC 次數依 JVM 和機器負載而變動。

分析自己的錄製檔時，第二個參數填入代表作業期間的 JFR 事件名稱。錄製端須啟用作業事件及 `jdk.GCPhasePause`，門檻會影響能觀察到的事件。可用 `jfr summary sample.jfr` 檢視事件數。若事件類型存在但沒有樣本，該組 p95 為 null；檔案無法讀取或作業名稱不在錄製檔的中繼資料中時，程式以結束碼 2 回報。

| JSON 欄位 | 判讀方式 |
| --- | --- |
| operations、with_pause | 作業總數，以及有正長度重疊的作業數 |
| pause_events、pause_wall_ns | 原始頂層 GC 暫停事件數，以及合併暫停區間後的牆鐘奈秒數 |
| operation_overlap_ns | 每筆作業與暫停聯集的交集長度加總，同時進行的作業分開計入 |
| operation_p95_ns、with_pause_p95_ns、without_pause_p95_ns | 全部、有重疊、無重疊作業的實際持續時間 p95，採最近秩法 |

時間重疊可用於定位值得檢查的請求；估算 GC 對延遲的因果影響還需要控制負載等其他因素。工具用半開區間處理端點，把暫停排序、合併後建立累計時間，對每筆作業的起訖各做一次二分搜尋。[JDK 錄製檔讀取 API](https://docs.oracle.com/en/java/javase/21/docs/api/jdk.jfr/jdk/jfr/consumer/RecordingFile.html)

## 驗證

JDK 21 的 `java`、`javac`、`jfr` 均在 PATH 上時，執行 `python verify.py`。測試逐刻枚舉 6,000 組查詢，涵蓋重複、交錯、相接與空區間。接著錄製實際 JFR，透過 JDK 的 `jfr print --json` 另行匯出原始時間，以 Python 切分所有觀測端點並核對每一個報表欄位。專案以 AI 輔助開發。
