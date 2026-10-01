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

網站先還原 Google News 原媒體連結，讀取公開內容，再由 Cloudflare Workers AI 的 `@cf/qwen/qwen3-30b-a3b-fp8` 產生繁體中文事實摘要。模型固定在程式中，不接受環境變數切換成付費模型。草稿不直接寫入週報，必須人工按「套用摘要草稿」。不再呼叫 OpenAI，也沒有付費服務 fallback、自動重試或自動儲值。

若原文受限（例如媒體回傳 `429`），優先使用有內容的監測節錄；若只剩標題，明確標示「未取得原文」，不消耗 AI 額度改寫標題。可展開「原文擷取受限時，貼上可讀內容後再產生」，貼入至少 60 字的原文或節錄再摘要。貼入內容與摘要會保存在此裝置工作紀錄；產生時會傳到 Cloudflare AI，但不提交到 GitHub 或自動寫入週報。伺服器自動擷取的原文全文不回傳至瀏覽器。

### 免費版啟用設定

1. 先到 Cloudflare 的 Workers & Pages 方案頁確認此帳號是 **Workers Free**。這與網域的 Free 方案不同。Workers AI 每日免費 10,000 Neurons 為帳號共用額度，Free 方案超額即拒絕；**Workers Paid 超額會計費**，因此免費版必須保持 Workers Free，不使用 AI Gateway 預付額度或 Unified billing。
2. `wrangler.json` 已宣告 `ai.binding = "AI"`；GitHub 自動部署會加入 AI 綁定。若 Dashboard 仍未顯示，請到 `pr-statusreport → Bindings` 新增 **Workers AI**，名稱填 `AI`。
3. 沿用既有 Production secret `PR_SUMMARY_ACCESS_KEY`，它是工作台存取碼，不是第三方 API 金鑰。無須重設。
4. 確認 Workers Free 後，到 `pr-statusreport → Settings → Variables and Secrets` 新增一般文字變數 `PR_SUMMARY_FREE_PLAN_CONFIRMED`，值為 `true`，儲存並部署。沒有此確認時程式拒絕生成，避免誤在 Paid 方案運行。**此變數是人工確認，不會自動查詢帳務；未來改為 Paid 時，須先移除此變數或設成 `false`。**
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
- 目前取用智冠產業監測的已分類彙整資料；公司／IR 專用新聞會在同步時排除。只保留近 10 天、去除相同標題，最多 80 則產業候選新聞；這些是待人工確認的選題，不會自動進入週報。
- Cloudflare Workers 已追蹤 `main` 並發布 `dist/`，所以資料檔被 Actions 推回 GitHub 後，Cloudflare 會自行重建；新聞同步本身不需要 API Token 或額外秘密金鑰。只有上述按需 AI 摘要功能需要 Cloudflare secret。

### 第一次需要手動開啟的設定

1. 進入 GitHub 專案 **Settings → Actions → General → Workflow permissions**。
2. 選取 **Read and write permissions**，並按 **Save**。這讓排程可以把更新過的新聞資料提交回 `main`。
3. 若 GitHub 顯示 Actions 尚未啟用，依畫面提示啟用它。

完成後不必每天操作 Cloudflare。若想確認部署仍正常，可在 Cloudflare 的 `pr-statusreport` Worker → **Builds** 檢查 Production branch 是 `main` 且沒有暫停。
