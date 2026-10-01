# 公關週報工作台

把智冠產業監測的新聞，串成「篩選選題 → 整理摘要 → 產出週報 → 人工確認」的單一工作流程。

## 使用方式

1. 開啟公開網站；左側「本週流程」一次只顯示一個工作頁，收件匣會自動讀取已部署的監測候選新聞。
2. 在「監測收件匣」用「高重要度」搭配「金融支付」、「遊戲產業」或「競品與產業」篩選，優先查看重大支付／穩定幣、競業與新作訊號；每則原始連結都保留在收件匣供查核。
3. 切到「篩選選題」，勾選真正要寫入本週報的新聞、調整順序，並選擇它要進入的產業【類別】。
4. 切到「週報草稿」，將「週報內文」寫成事實句（主體、動作、關鍵數字或背景）；需要時在「補充資訊／編輯註記」填入使用流程、限制或備註。
5. 在草稿頁檢查週報版型預覽與可編輯文字，再複製文字輸出；不會產生 Word 檔。
6. 在「人工確認」核對內容並儲存本週紀錄；選題、摘要、註記與週報紀錄保存在這台裝置的瀏覽器中。同步新資料不會覆蓋已選題或已編輯的新聞。

## AI 摘要草稿（選題後才執行）

網站會先把 Google News 跳轉連結還原為原媒體網址，讀取可公開取得的內容，再由 OpenAI 產生繁體中文的週報摘要草稿。草稿不會直接寫入週報，必須由編輯按下「套用摘要草稿」。

部分新聞網站會限制 Cloudflare 伺服器讀取（例如回傳 `429`），這不是存取碼或 OpenAI 金鑰的問題。遇到此情況，工作台會改產生明確標示「僅依新聞標題」的保守草稿，並提示人工核對；若要取得接近原文的品質，可在該則新聞的「原文擷取受限時，貼上可讀內容後再產生」展開區塊貼入原文前幾段或全文，再按一次產生摘要。貼入內容只用於該次摘要和本機工作紀錄，不會提交至 GitHub 或自動寫進週報。

為了讓公開網站不會被陌生人用來消耗 API 額度，第一次啟用時需要由管理員在 Cloudflare 設定兩個 **Production secret**：

1. 進入 **Cloudflare Dashboard → Workers & Pages → pr-statusreport → Settings → Variables and Secrets**。
2. 新增加密 secret `OPENAI_API_KEY`：貼入在 OpenAI API 平台建立的金鑰。ChatGPT 訂閱與 API 用量是分開的；不要把金鑰貼進 GitHub、網站程式碼或聊天訊息。
3. 新增加密 secret `PR_SUMMARY_ACCESS_KEY`：自訂一組至少 24 個字元的隨機存取碼。這不是 OpenAI 金鑰；它是讓網站使用者啟用摘要按鈕的工作台密碼。
4. （選填）新增一般文字變數 `OPENAI_MODEL`，例如 `gpt-6-astra`。若未設定，Worker 預設使用 `gpt-6-astra`。
5. 儲存後重新部署 Production，或等待 Cloudflare 自動重建完成。

使用時，在左側「AI 週報摘要」輸入 `PR_SUMMARY_ACCESS_KEY` 並按「啟用摘要」，勾選一則新聞，再按該則新聞的「擷取並產生摘要」。存取碼只保留在目前瀏覽器工作階段；原文全文不會寫入瀏覽器、本機週報紀錄或 GitHub。

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
