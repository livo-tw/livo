# 參與開發

謝謝你願意幫忙。回報問題、改文件、修 bug、加功能都歡迎。

## 回報問題

開 issue 時請寫清楚：用哪一種部署方式（本機開發、Docker、Cloudflare）、瀏覽器、操作步驟、預期結果和實際結果。有截圖或錯誤訊息更好。

安全性問題請不要開公開 issue，照 [SECURITY.md](SECURITY.md) 私下回報。

## 開發環境

照 [README](README.md) 的「在自己電腦上跑起來」設定好。前端在 `http://localhost:5173/demo/`，API 在 `http://localhost:8787`。

## 送 PR 之前

請在本機跑過這幾項（CI 也會跑同樣的檢查）：

```bash
npx tsc --noEmit
npx vitest run
npx vite build
cd worker && npx tsc --noEmit
```

- 一個 PR 做一件事，說明裡寫清楚改了什麼、為什麼、怎麼驗證。
- 程式風格請參考 [CODING_STANDARDS.md](CODING_STANDARDS.md)。
- 新增介面文字時，三個語系檔（`src/i18n/locales/zh-TW.json`、`zh-CN.json`、`en.json`）都要補。

## 資料庫變更

- **Cloudflare 版（D1）**：改 `worker/schema.sql`，保持可重複執行（`CREATE TABLE IF NOT EXISTS`）。替既有資料表加欄位時，寫進 `worker/migrate/tenant-alters.sql`（`npm run db:migrate:*` 會先跑它）。新的資料表或欄位要登記到 `worker/src/tables.ts`，布林與 JSON 欄位一定要列進 `boolCols` / `jsonCols`，只給後端用的資料表設 `clientAccess: 'none'`。
- **多租戶**：業務資料表都有 `workspace_id`。`worker/src/db.ts` 會自動加上工作區條件；自己寫的 SQL 碰到業務資料表時，一定要帶 `workspace_id` 條件。
- **Docker 版（Postgres）**：在 `supabase/migrations/` 新增一個可重複執行的 migration；改到 edge function 時，改的是 `docker/volumes/functions/`。

## 貢獻者授權協議（CLA）

第一次送 PR 需要簽署 [CLA](CLA.md)。你仍然擁有自己程式碼的著作權；CLA 讓維護者除了 AGPL-3.0 之外，還能用其他條款授權包含你貢獻的 LIVO（例如提供商業授權），專案因此能長期維護下去。PR 頁面會說明怎麼簽。
