# QA Bug 與 Slack

管理員在「系統管理 → 功能開關」開啟 **QA Bug**。要使用 Slack，再開啟 **Slack 互動**。兩個開關預設關閉；關閉後保留資料，同時停用相應 UI、API 與 Slack 操作。

QA 提供獨立看板與列表。全公司（同一工作區）共用一套流程顯示設定：管理員可在 QA 的流程設定更改五個狀態名稱與欄位順序，留白使用目前語系的預設名稱。設定套用至所有專案，不新增或刪除階段，也不改變各角色的操作權限。看板卡片透過「檢視／處理」完成既有動作；排序欄位不等同允許跳過驗證。Slack 新建或下次更新操作卡時使用同一套名稱。

QA 是獨立資料與流程，可連結多個既有任務，沒有同步建立影子任務。流程為待分流 → 待修復 → 修復中 → 驗證階段 → 已結案。分流指定 RD 與驗證 QA；修復者提交版本與必要環境，部署完成後才可驗證。每次 PASS / FAIL / BLOCKED 都保留獨立紀錄；FAIL 返回修復中，下一次提交修復才增加修復輪次。所有必要環境的最新紀錄均 PASS 後，由 QA 明確結案。也可附理由重開，或以重複單、非 Bug、不修復、無法重現結案。

## Slack 操作

| 操作 | 入口 |
| --- | --- |
| 新增 Bug | `/livo bug new 問題標題`、訊息選單「建立 QA Bug」、Bug 操作卡的新增按鈕 |
| 查看 | `/livo bug show BUG_ID` |
| 將 LIVO Bug 分享到目前頻道並綁定討論串 | `/livo bug link BUG_ID` |
| 回報修復 | `/livo bug fix BUG_ID`，或卡片「回報修復」 |
| 部署 | `/livo bug deploy BUG_ID`，或卡片「部署完成」 |
| 驗證 | `/livo bug pass BUG_ID`、`fail`、`blocked`，或卡片按鈕 |
| 結案／重開／留言 | `/livo bug close BUG_ID`、`reopen`、`comment` |

BUG_ID 可從 LIVO 詳情複製。開單表單帶入原訊息與永久連結；附件透過 LIVO 私人證據區上傳，Slack 檔案不自動下載或公開轉存。命令與按鈕都使用同一套權限、版本衝突檢查及稽核紀錄。

同一 Slack 討論串只綁定一張 Bug。已綁定串的人類回覆會同步為 LIVO 留言；機器人、編輯／刪除事件及未綁定串忽略。RD 回覆「已修復／已修正」或 QA 回覆「PASS／已修正／FAIL」時，系統提示該人的可用操作，補齊版本、環境及驗證依據後更新同一 Bug。「還沒修正」及含糊敘述只作留言，避免誤結案。LIVO 狀態變更也刷新已綁定的 Slack 操作卡。

訊息事件先保存於私人 inbox 再 ACK。處理失敗會重試，相同事件不重複新增留言。Docker 以 relay heartbeat 觸發重試；Cloudflare 以既有 scheduled cron 觸發，延遲取決於 cron 間隔。收件記錄保存 30 天。Slack 故障不回滾已完成的 LIVO 操作；可再次查看／操作來刷新訊息卡。

## Docker 啟用

1. 依安裝 README 設定 Socket Mode、App Token、Bot Token、APP_BASE_URL，並保留現有任務捷徑。
2. 可參考 `release-template/slack-qa-manifest.json` 合併 Slack App 設定：新增 `livo_qa_new` message shortcut；啟用 Event Subscriptions 的 `message.channels`、`message.groups`；加入 `channels:history`、`groups:history` scopes，重新安裝 App。
3. 邀請 Bot 進需要使用的頻道。Slack 成員須對應唯一且啟用中的 LIVO 登入帳號（Email 或原有管理員綁定）。
4. 升級安裝包並重啟 compose。新 migration 經既有備份與升級機制套用；qa edge function 使用原 gateway 路由。

單檔上限沿用 200 MB。QA 使用獨立私人 `qa-evidence` bucket；簽名上傳、實際物件驗證完成後才建附件紀錄。下載需已登入且 QA 功能開啟。

## Cloudflare 啟用

在 Worker 設定 Slack App 的 `SLACK_SIGNING_SECRET` secret，Bot Token 沿用每個 workspace 的 Slack 設定。此 HTTP 接法使用該 signing secret 對應的同一 Slack App；不同客戶自建 App 不能共用不同 signing secret。

將 Slash Command、Interactivity、Event Subscriptions Request URL 設為：

`https://api.livo-tw.com/api/functions/qa-slack/<workspaceId>`

使用 HTTP 接法時關閉該 App 的 Socket Mode；從上面的 manifest 保留 QA 捷徑與 scopes，移除只適用 Docker 的兩個一般任務捷徑。此路由提供 QA 命令；既有 Cloudflare 通知功能維持原設定。要求原始 body HMAC 驗證、5 分鐘有效期、Slack team 與該租戶 Bot 一致，並以 Slack Email 匹配同租戶唯一、啟用且未停權的 LIVO 登入帳號。舊版可由客戶端編輯的 binding 不用於身分授權。

私人 R2 證據採 5 MB 分段上傳，單檔 200 MB，計入租戶容量配額。支援圖片、影片與文字記錄；不開放可执行附件。下載由已登入的 QA API 代理，不提供公開 R2 URL。

## 備份與驗證範圍

QA 資料、留言、驗證歷史、附件 metadata 與 Slack 關聯納入備份。inbox 與提示去重 receipts 不備份。備份 JSON 不內嵌影片；還原會預檢私人物件是否存在，拒絕缺失證據或衝突資料，不宣稱跨 Docker / R2 物件自動搬遷。

還原期間請暫停團隊寫入。QA 部分有自己的原子驗證與提交；整份既有備份的普通業務表仍沿用逐表還原，並非所有表共同一個交易。

自動測試涵蓋流程權限、多環境驗證、版本衝突、事件去重、功能關閉、私人附件與還原預檢。正式 Slack App scopes、Event Subscriptions 與實際部署環境需設定後再做真人 RD → QA 往返驗收；本次程式變更不會自行修改既有 Slack App 或匯入歷史 Bug。
