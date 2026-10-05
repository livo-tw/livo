# QA Bug 與 Slack

管理員在「系統管理 → 功能開關」開啟 **QA Bug**。要使用 Slack，再開啟 **Slack 互動**。兩個開關預設關閉；關閉後保留資料，同時停用相應 UI、API 與 Slack 操作。

QA 提供獨立看板與列表，建立與查看 Bug 使用與任務卡相同的彈窗、側邊欄、整頁偏好。內容在左，環境、版本、狀態和負責人在右；選填的預期結果與重現步驟直接展開。專案、環境等單選選項超過五個時可輸入關鍵字搜尋，只能選清單內的值；產品版本保留手動輸入與既有版本建議。

工作區共用一套 QA 顯示流程：新回報、已指派、修復中、待驗證、驗證通過待結案（PASS）、驗證未通過（FAIL）、已結案、不處理。App 與 Slack 使用同一組預設名稱。管理員或 QA 管理員可改名稱、顺序和顯示分組；不新增或刪除系統階段。QA 管理員由最高管理員指派，只增加管理 Bug 自訂欄位與 QA 流程的能力，不取得其他系統管理權限。自訂欄位支援文字、多行文字、數字、日期、單選與是／否；可設定必填與停用，停用保留舊值。

狀態可直接從 Bug 詳情選單切換或看板拖放。管理員、回報人和該單負責人可以手動切換各狀態；操作保留紀錄與版本衝突保護。手動 PASS 或已結案只變更工作狀態，不建立驗證、部署或修復證據；移到「已結案」或「不處理」前會先確認。PASS 與已結案仍是不同階段。卡片與詳情的「下一步」依 Bug 實際缺少的東西決定（負責人、修復版本、部署、驗證通過），手動切過狀態也不會指向做不了的操作。

若需正式記錄修復與驗證，仍可使用專門操作：提交修復版本與必要環境，部署完成後由 QA 記錄 PASS／FAIL／BLOCKED；所有必要環境的最新紀錄 PASS 後正式結案。正式結案仍要求證據，歷史 PASS 須確認來源，不會補造驗證記錄。QA 可連結既有任務，沒有同步建立影子任務。

阻礙（記錄阻礙）寫在 Bug 上並顯示在卡片；排除後可直接「解除阻礙」，不需要原因。重開原因另存為 `reopenReason`，不再當成阻礙顯示（舊資料重開時寫進阻礙欄位的文字仍可用「解除阻礙」清掉）。結案為「重複問題」時可輸入卡片上的短編號（#1a2b3c4d），原始 Bug 必須在同一專案。搜尋框以 `#` 開頭時找編號，其他文字找標題。

通知收件人由共用規則 `qaNotificationRecipients` 決定，雲端與 Docker 相同：新回報給該專案的 QA 協調人，沒有協調人時給管理員；留言、手動改狀態、結案給回報人、修復負責人與 QA 負責人；提交修復與部署給 QA 負責人；設定負責人、驗證結果、重開、阻礙、編輯給修復與 QA 負責人；交接給接手的人；開始修復與關聯任務不通知。操作者本人不會收到。等待自己接手的交接會出現在右上角「我的任務」。

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

BUG_ID 可從 LIVO 詳情複製。開單表單帶入原訊息與永久連結；若團隊設有必填自訂欄位，請使用 LIVO 的完整回報表單，Slack 簡易新增不會略過必填驗證。附件透過 LIVO 私人證據區上傳，Slack 檔案不自動下載或公開轉存。命令與按鈕都使用同一套權限、版本衝突檢查及稽核紀錄。

同一 Slack 討論串只綁定一張 Bug。工作區在職成員都可以留言，包含已結案的 Bug（任務留言同樣規則）；已綁定串的人類回覆會同步為 LIVO 留言；機器人、編輯／刪除事件及未綁定串忽略。RD 回覆「已修復／已修正」或 QA 回覆「PASS／已修正／FAIL」時，系統提示該人的可用操作，補齊版本、環境及驗證依據後更新同一 Bug。「還沒修正」及含糊敘述只作留言，避免誤結案。LIVO 狀態變更也刷新已綁定的 Slack 操作卡。

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


## 專案協調與跨部門交接（可選）

管理員可在 QA 工作區選定專案後指定一位協調人，或清除設定。協調人可設定負責人、記錄阻礙、安排交接；這項任命不授予驗證 PASS 或結案權。協調人在任何專案的看板卡片上都會看到自己可做的下一步（不必先在側欄選該專案）。RD 與 QA 負責人仍由「設定負責人」表單明確指定，其他驗證與修復規則不變。

交接是 Bug 內的獨立紀錄，包含原因、下一位內部責任人、可選回覆時間、外部依賴、接收時間及解除證據。接收者必須本人接收；接收交接不同於任務指派確認。接收者或管理員可附證據解除，協調人不代替接收者確認完成。以上操作都不會自動產生 PASS、部署、結案或改派 RD／QA。回覆時間不會自動觸發懲罰、升級或週期提醒。

Slack 私密面板可從 Bug 詳情按鈕或以下指令開啟：

- `/livo bug triage ISSUE_ID`：指定 RD／QA、嚴重程度、優先級及可選期限。
- `/livo bug start_fix ISSUE_ID`：開始修復。
- `/livo bug hold ISSUE_ID`：記錄卡關原因。
- `/livo bug request_handoff ISSUE_ID`：建立或替換交接，舊內容保留在事件歷史。
- `/livo bug accept_handoff ISSUE_ID`：由下一位責任人接收。
- `/livo bug resolve_handoff ISSUE_ID`：附解除證據。

表單保留開啟時的 Bug 版本；衝突時需重新開啟。重送相同命令不重複寫事件或通知。專案協調設定也採版本與命令識別碼控制；後端會在交易內重新檢查成員、授權、封存與 Slack 身分。

新增 PostgreSQL migration `20261012_qa_coordination.sql` 與 D1 coordination upgrades。完整 QA／排程備份包含協調設定、設定收據及 issue JSON 中的交接。舊備份沒有交接時不推測或補造紀錄。舊 PG→D1 搬移器尚不轉換完整 QA 歷史，偵測到 QA 資料會停止，應改用 QA 完整備份還原。Jira 全清重匯若會刪除 QA 已連結的任務，會在刪除子資料前停止。
