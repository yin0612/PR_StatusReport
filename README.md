# 公關週報工作台

把智冠產業監測的新聞，串成「篩選選題 → 整理摘要 → 產出週報 → 人工確認」的單一工作流程。

## 使用方式

1. 開啟公開網站；左側「本週流程」一次只顯示一個工作頁，收件匣會自動讀取已部署的監測候選新聞。
2. 在「監測收件匣」用「高重要度」搭配「金融支付」、「遊戲產業」或「競品與產業」篩選，優先查看重大支付／穩定幣、競業與新作訊號；每則原始連結都保留在收件匣供查核。
3. 切到「篩選選題」，勾選真正要寫入本週報的新聞、調整順序，並選擇它要進入的產業【類別】。
4. 切到「週報草稿」，將「週報內文」寫成事實句（主體、動作、關鍵數字或背景）；需要時在「補充資訊／編輯註記」填入使用流程、限制或備註。
5. 在草稿頁檢查週報版型預覽與可編輯文字，再複製文字輸出；不會產生 Word 檔。
6. 在「人工確認」核對內容並儲存本週紀錄；選題、摘要、註記與週報紀錄保存在這台裝置的瀏覽器中。同步新資料不會覆蓋已選題或已編輯的新聞。

## Cloudflare 免費摘要（選題後才執行）

勾選新聞後，按收件匣上方「摘要已選新聞」，逐則閱讀文章主文，再由 Cloudflare Workers AI 的 `@cf/qwen/qwen3-30b-a3b-fp8` 整理核心事件、數字、時程及條件。單則也能按「擷取並產生摘要」。草稿不直接寫入週報，必須人工按「套用摘要草稿」。模型固定，不呼叫 OpenAI，也沒有付費 fallback、自動重試或自動儲值。遇到 AI 額度或模型錯誤時，整批停止；單則內文讀不到則略過並顯示原因。

### 文章內文擷取（不是改寫標題）

Cloudflare Worker 的即時請求曾收到 Google News `429`／媒體 `403`，但相同公開網址在一般執行環境可以讀取。因此 `wrangler.json` 的 custom build 會先執行 `scripts/build-article-cache.mjs`，在部署執行環境還原原媒體連結、擷取主文，再打包進 Worker 私有程式中。每次新聞同步導致部署時重新產生，不需要額外金鑰或付費 API；擷取本身不執行 AI。

- 只取公開可讀文章，不使用代理服務、不破解驗證、不登入或繞過付費牆。
- 快取先於即時擷取使用，最多保留本次 80 則候選的主文，逾 48 小時失效。擷取限兩個並行作業、90 秒啟動預算、每個外部請求 5 秒，不讓單一網站阻止整體部署。
- 檔案位於被 Git 忽略的 `.generated/article-cache.json`，不在 `dist/`、GitHub 或 GitHub Pages；Worker 沒有公開全文下載 API。**不要把這個目錄或新聞全文提交至 GitHub。**
- 每次只將已選題新聞的主文交給 AI。未選新聞不執行摘要；主文超過 16,000 字會明確標示前後段節錄，不假稱讀完整篇。
- 若只讀到媒體描述或監測節錄，會標示非完整內文；若只剩標題，回傳 `article_body_unavailable`，不產生可套用的假摘要，也不消耗 AI 額度。舊標題快取不會被重用。
- 仍無法擷取的文章，可展開「原文擷取受限時，貼上可讀內容後再產生」，貼入至少 60 字、最多 16,000 字的原文或節錄。

每小時同步會保留既有 `publisherUrl`，至多還原 12 個新原媒體連結；部署優先讀取這些直接網址，最多額外解析 8 個未解析的 Google News 連結。遇到 Google `429` 停止該批解析，不密集重試；未取得連結者等待後續同步或人工補充。`config/publisher-links.json` 只含已查核的公開網址，沒有新聞全文。

貼入內容與摘要會保存在此裝置工作紀錄；產生時會傳到 Cloudflare AI，但不提交到 GitHub 或自動寫入週報。伺服器擷取的內文不回傳至瀏覽器。左側「檢查設定」會顯示本次部署取得的文章／節錄數量，但不消耗 AI 額度。

### 免費版啟用設定

1. 先到 Cloudflare 的 Workers & Pages 方案頁確認此帳號是 **Workers Free**。這與網域的 Free 方案不同。Workers AI 每日免費 10,000 Neurons 為帳號共用額度，Free 方案超額即拒絕；**Workers Paid 超額會計費**，因此免費版必須保持 Workers Free，不使用 AI Gateway 預付額度或 Unified billing。
2. `wrangler.json` 已宣告 `ai.binding = "AI"`；GitHub 自動部署會加入 AI 綁定。若 Dashboard 仍未顯示，請到 `pr-statusreport → Bindings` 新增 **Workers AI**，名稱填 `AI`。
3. 沿用既有 Production secret `PR_SUMMARY_ACCESS_KEY`，它是工作台存取碼，不是第三方 API 金鑰。無須重設。
4. 2026/10/01 已在帳號的 Workers plans 頁確認 **Free 為 Current plan**，因此 `wrangler.json` 已設定 `vars.PR_SUMMARY_FREE_PLAN_CONFIRMED = "true"`，隨 GitHub 部署啟用，不需重設存取碼。其他帳號部署前須重新確認方案；未確認時應設為 `false`。**此變數是人工確認，不會自動查詢帳務；未來改為 Paid 時，須先在 `wrangler.json` 把此值設為 `false` 並部署停用摘要，不能只改 Dashboard（下一次 Git 部署會覆蓋）。**
5. 回工作台輸入原有存取碼、按「啟用摘要」，再按「檢查設定」。檢查不執行模型、不消耗 AI 額度，也不查詢帳號餘額；實際生成才驗證 AI 模型存取與當日額度。

不需建立或儲值 OpenAI API。既有 `OPENAI_API_KEY`／`OPENAI_MODEL` 不再被程式讀取；不用刪除也不會因本網站消耗 OpenAI 額度。

### 節省額度與超額行為

- 只處理手動點擊的已選新聞，一次一則；同步候選新聞與週報組版不會執行 AI。
- 此裝置保留來源指紋和草稿，相同內容再次點擊直接重用；修改標題、日期、原文或節錄後才需重新生成。要重新擷取已變動的媒體頁，請貼入新原文再產生。
- Worker 同一執行個體額外保留最多 128 則、24 小時的摘要快取，合併同時發生的相同請求。這不是跨裝置永久資料庫，執行個體回收會失效；硬性免費上限仍由 Workers Free 平台保障。
- Cloudflare 錯誤 `3036` 代表今日免費額度用完，工作台停止新摘要至每日 UTC 00:00（台灣時間 08:00）重置。既有本機摘要、人工編輯與週報輸出仍可使用。
- `3040` 或其他速率限制表示暫時忙碌，不假稱額度用完；`5035` 表示模型需付費，直接停止，絕不自動升級或更換付費模型。

官方說明：[Workers AI 定價](https://developers.cloudflare.com/workers-ai/platform/pricing/)、[錯誤碼](https://developers.cloudflare.com/workers-ai/platform/errors/)、[AI binding](https://developers.cloudflare.com/workers-ai/configuration/bindings/)。

### 貼入格式

每列一則新聞，欄位以直線 `|` 分隔：

```text
標題 | 媒體 | 2026-09-29 | https://example.com/article | 主題 | 週報內文
```

CSV 可使用相同欄位順序；JSON 可為新聞物件陣列，欄位支援 `title`、`source`、`date`、`url`、`topic`、`excerpt`、`summary`、`reportGroup`。

產出的文字週報採既有 `Soft-World PR & IR Department STATUS REPORT 工作進度報告` 格式：`Date`、`產業訊息`，以及【市場新遊動態】、【遊戲產業動態】、【金融科技產業動態】、【穩定幣相關新聞】等分類。IR 訊息不會顯示或占用候選新聞額度；原文連結保留於收件匣，複製出的週報文字不加入網址。

## 自動同步、GitHub 與 Cloudflare

### 更新可靠性與人工查核

- 新聞日期統一換算 `Asia/Taipei`。頁面分別顯示來源生成、GitHub 同步成功、網站建置及本機檢查時間；建置時間不是 Cloudflare 帳務或實際部署完成時間。
- 排程設定每小時第 17 分，但 GitHub Actions 可能延遲或略過；上游資料也有自己的更新頻率，不保證每小時都有新新聞。同步超過 3 小時或來源超過 8 小時會提示延遲，不把舊資料標為最新。
- 網頁每 5 分鐘檢查已部署資料，回到分頁也會檢查；正在輸入、摘要執行中不覆蓋編輯區。同步保留人工草稿、已選題及摘要，不會執行 AI。讀取失敗或無效／空資料保留上一版。
- 預覽與複製文字使用同一份草稿，手動修改即時反映；重新開啟也保留手動版本。週報內容、日期、來源、分類或排序變更會取消先前核對狀態，必須重新確認。
- 排除純股價／權證快訊，「信用卡大小」等周邊產品描述不歸為支付。僅合併去除媒體後綴後相同的標題，保留其他轉載來源供查核；不同角度報導不自動刪除，仍須人工判斷是否為同一事件。
- 同步及 Cloudflare 建置都先執行測試。`dist/data/deployment-status.json` 在建置時產生，只含公開時間資訊；不含金鑰或文章全文。
- AI 摘要仍是待核對草稿，規則與測試不能保證新聞或模型內容百分之百正確，數字、條件及原文仍須人工查核。

`main` 分支是唯一發布來源，流程如下：

```text
智冠產業監測
        ↓（每小時）
GitHub Actions 產生 dist/data/monitoring-news.json 並提交至 main
        ↓（自動）
Cloudflare Workers Builds 發布公開網站
```

- 同步工作流程位於 `.github/workflows/refresh-monitoring-news.yml`，每小時第 17 分執行，也可在 GitHub 的 **Actions → Refresh monitored news → Run workflow** 手動立即更新。
- 同步程式位於 `scripts/sync-media-feed.mjs`；來源、保留天數與候選上限可在 `config/watchlist.json` 調整。
- 改用與智冠監測網相同的完整 `/api/articles`，取得資料庫、即時 RSS 補位、官方 RSS 快照及 Google News 聚合的合併結果，依 API 分頁取完。範圍為台北日期往前兩個月，取消 400 則上限。平台商業、新商機、行銷科技納入「其他」，一帆數位／發票大師／簡單付納入金融科技；只有公司／IR 專用新聞及純股價快訊排除，混合命中產業的公司新聞保留。候選不會自動進入週報。API 失敗、回報資料不完整或分頁停滯時不覆寫上一版；上游仍可能缺新聞，不能保證全網完整收錄。只匯入最多 600 字監測節錄，不將完整主文提交至 GitHub；部署時文章主文快取仍最多處理 80 則。
- Cloudflare Workers 已追蹤 `main` 並發布 `dist/`，所以資料檔被 Actions 推回 GitHub 後，Cloudflare 會自行重建；新聞同步本身不需要 API Token 或額外秘密金鑰。只有上述按需 AI 摘要功能需要 Cloudflare secret。

### 第一次需要手動開啟的設定

1. 進入 GitHub 專案 **Settings → Actions → General → Workflow permissions**。
2. 選取 **Read and write permissions**，並按 **Save**。這讓排程可以把更新過的新聞資料提交回 `main`。
3. 若 GitHub 顯示 Actions 尚未啟用，依畫面提示啟用它。

完成後不必每天操作 Cloudflare。若想確認部署仍正常，可在 Cloudflare 的 `pr-statusreport` Worker → **Builds** 檢查 Production branch 是 `main` 且沒有暫停。
