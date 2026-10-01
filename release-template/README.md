# LIVO 自架部署說明

歡迎使用 **LIVO 專案管理系統**（自架版）。本套件讓你在自己的伺服器上，用 Docker
架設完整的後端與前端，**所有資料都留在你自己的機器上**，不經過任何雲端服務。

> **只要裝好 Docker，執行一個安裝程式就完成**：Windows 點兩下 `install.bat`，
> Linux / macOS 執行 `sh install.sh`。不需要懂資料庫、不需要安裝 Node.js、
> 不需要複製貼上任何 SQL。

---

## 套件內容

解壓縮後你會看到以下結構：

```
livo-release/
├── install.bat                  ← Windows 一鍵安裝（點兩下執行）
├── install.sh                   ← Linux / macOS 一鍵安裝（sh install.sh）
├── installer/                   ← 安裝程式的輔助檔（不需手動執行）
├── README.md / 部署說明.md      ← 本文件
├── LICENSE                      ← 授權條款（GNU AGPL-3.0）
├── app/                         ← 前端（已編譯；由 Docker 容器直接服務）
├── docker/                      ← 後端（自架 Supabase + 前端容器，Docker Compose）
│   ├── docker-compose.yml       ← 後端服務
│   ├── compose.frontend.yml     ← 前端服務（免裝 Node.js）
│   ├── .env.factory             ← 出廠範本（第一次安裝時複製成 .env，並換成本安裝專屬金鑰）
│   └── volumes/                 ← 各服務設定檔（不含任何資料，全新安裝）
└── schema/
    ├── livo-schema.sql          ← 資料庫結構（安裝程式會自動匯入）
    ├── upgrades/                ← 資料庫更新（舊版升級時，安裝程式會自動套用）
    └── migrations/              ← 原始 migration 檔案（僅供參考）
```

---

## 1. 系統需求

| 項目 | 最低需求 | 建議 |
|------|---------|------|
| 作業系統 | Windows 10/11、macOS、Linux | Ubuntu 22.04 LTS |
| CPU | 2 核心 | 4 核心 |
| RAM | **4 GB**（給 Docker） | 8 GB |
| 硬碟 | 20 GB | 50 GB+ |
| Docker | 24.0+（含 Compose v2） | 最新版 |

**唯一要先自己裝的東西是 Docker：**

- **Windows / macOS**：安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/)
  （Windows 需要 WSL2，Docker Desktop 安裝時保持預設即可）
- **Linux**：`curl -fsSL https://get.docker.com | sh`，然後
  `sudo systemctl enable --now docker`

> 不需要安裝 Node.js —— 前端由 Docker 容器直接服務。

---

## 2. 一鍵安裝（推薦）

1. 把 `livo-release.zip` 解壓縮到想放置的目錄
2. 確認 Docker 正在執行（Docker Desktop 左下角綠燈 / `docker ps` 有回應）
3. 執行安裝程式：
   - **Windows**：對套件根目錄的 `install.bat` **點兩下**
   - **Linux / macOS**：開終端機，到套件根目錄執行 `sh install.sh`

安裝程式會自動完成以下事情（第一次執行約 5–15 分鐘，大部分時間在下載映像檔）：

1. 檢查 Docker 環境與連接埠（**真實 bind 測試**，連 Windows 系統保留埠段也
   偵測得到；若 API 埠 8000 無法使用會**自動改用備選埠**並同步更新前端）
2. **產生這套安裝專屬的金鑰與密碼**（JWT 金鑰、資料庫密碼、管理後台密碼；
   每套安裝都不一樣，別人拿到相同的安裝包也連不進你的系統）
3. 啟動全部後端服務 + 前端
4. 等待資料庫就緒，**自動匯入完整資料庫結構**
5. 互動式建立你的**第一個管理員帳號**（輸入 Email 與密碼即可）
6. 印出登入網址與後續步驟

安裝完成後：

- **LIVO 前端**：<http://localhost:3000/demo/>（登入頁 <http://localhost:3000/demo/auth>）
- 用剛剛建立的管理員帳號登入
- **同事從自己的電腦使用**：開 `http://<伺服器 IP 或主機名稱>:3000/demo/`。網頁會自動
  透過同一個網址與連接埠存取 API、上傳檔案及即時協作，所以防火牆只需讓同事連得到
  **前端 3000 埠**（若有改前端埠，以安裝完成畫面為準）。API 埠（預設 8000）供
  本機 API 與管理後台使用，**不要對同事網路或網際網路開放**。

> 安裝程式**可以重複執行**：已完成的步驟會自動略過。安裝中斷（斷電、按到
> Ctrl+C）也沒關係，重新執行一次即可。之後想再建管理員或重設管理員密碼，
> 也是重新執行安裝程式。

---

## 4. 日常維運

### 知識庫

升級安裝程式會自動套用知識庫資料表、權限與即時更新設定，不需新增環境變數或外部服務。側欄「知識庫」可管理共用文件；專案看板標題旁的入口會開啟該專案的文件。知識庫常駐，不需功能開關或授權設定。

頁面最多三層，可以調整上層與排序。搜尋會跨所有範圍比對標題及內容。編輯時會取得協作鎖；若網路中斷或鎖失效，伺服器會拒絕過期保存，請保留草稿再重新開啟頁面。每次儲存與還原都會先保留原內容，最多 20 個舊版本。

所有成員可讀取、建立與編輯未鎖定的頁面。管理員可設定「僅管理員可編輯」、封存與刪除任何頁面；作者可刪除自己的頁面。刪除上層頁面前，須先移動或刪除子頁面。附件沿用 `task-images` 儲存桶與既有檔案大小限制，路徑為 `kb/<pageId>/…`；雲端租戶會自動加入工作區前綴。檔案網址與既有任務附件一樣可由持有連結的人存取。刪除頁面會移除版本與附件清單；若需刪除附件實體檔案，請先使用附件的刪除按鈕。正文圖片可能被舊版本引用，因此不隨編輯自動刪除。

以下指令都在 `docker/` 目錄執行：

```bash
# 停止（資料會保留）
docker compose -f docker-compose.yml -f compose.frontend.yml down

# 啟動
docker compose -f docker-compose.yml -f compose.frontend.yml up -d

# 看服務狀態 / 記錄
docker compose ps
docker compose logs -f
```

伺服器重開機後，Docker 會自動把服務帶起來（`restart: unless-stopped`）。

**想換前端連接埠**：在 `docker/.env` 加一行 `LIVO_FRONTEND_PORT=3001`，
然後重新執行安裝程式（或重新 `up -d`）。還沒執行過安裝程式的話，`docker/.env`
還不存在，改 `docker/.env.factory` 也可以。

**給團隊用的伺服器**：同事用 `http://<伺服器 IP>:3000/demo/` 開就能用，不必改設定
（見上方「安裝完成後」），只需開放前端 3000 埠。把下一段的 `APP_BASE_URL` 改成
同一個網址，Slack 通知裡的連結才點得開。8000 是本機 API 與管理後台，不能對外開放。

**架在正式網域（Slack 通知、邀請信連結）**：Slack 通知裡的任務連結，以及
匯入 Jira／「啟用帳號」寄出的「設定密碼」邀請信連結，都會用 `docker/.env` 的
`APP_BASE_URL`（預設 `http://localhost:3000`）組網址。若 LIVO 架在正式網域，
請把它改成實際網址（例如 `https://pm.example.com`，不含結尾斜線），再到
`docker/` 執行 `docker compose up -d` 重新載入。還是 `localhost` 時，邀請信會
改用管理員當下開著 LIVO 的網址。

### 用 HTTPS 網域對外（Cloudflare Tunnel 等）

1. 將 Tunnel 或反向代理的單一路由指向 `http://localhost:3000`（自訂前端埠時請替換），
   並啟用 WebSocket 轉送。這個位址適用於代理與 LIVO 同機執行；代理若在另一個容器，
   請在共用 Docker 網路上指向 `http://livo-frontend:3000`。
2. 在 `docker/.env` 把下列三個值都設為公開 HTTPS 網址，例如 `https://livo.example.com`
   （不含 `/demo/`、不含結尾斜線）：
   - `APP_BASE_URL`：Slack 任務連結，以及 Jira 匯入／啟用帳號的設定密碼邀請連結。
   - `SITE_URL`：GoTrue 的預設登入後返回網址；指定其他返回網址仍受 redirect allow-list 限制。
   - `API_EXTERNAL_URL`：GoTrue 對外的 Auth API 基底網址，用於驗證信連結等。
3. 在 `docker/` 執行 `docker compose -f docker-compose.yml -f compose.frontend.yml up -d`
   重新載入設定，再從 `https://livo.example.com/demo/` 開啟 LIVO。

前端會以同一個 HTTPS 網址呼叫 API，Realtime 自動使用 `wss://`。代理需保留 Host，
並覆寫 `X-Forwarded-Proto` 為使用者實際連線的協定；LIVO 會採用此標頭。
**不要將 Tunnel 指向 8000，也不要對外開放 8000**（若安裝時自動改了 API 埠，同樣適用）。
前端只代理 Auth、REST、Storage、Functions、Realtime 與 GraphQL，管理後台仍須在本機使用。

**自動備份**：內建排程服務（`livo-scheduler`）每小時檢查一次備份設定；
在 LIVO 的 **系統管理 → 備份設定** 開啟自動備份並設定間隔/時間即可，
不需要額外設定排程。

---

## 5. 安全性

**安裝程式會在第一次安裝時，自動為這套安裝產生一組全新的專屬金鑰**：
`JWT_SECRET`、`ANON_KEY`、`SERVICE_ROLE_KEY`、資料庫密碼 `POSTGRES_PASSWORD`、
管理後台密碼 `DASHBOARD_PASSWORD`、各服務內部加密金鑰（`SECRET_KEY_BASE`、
`VAULT_ENC_KEY`、`PG_META_CRYPTO_KEY`、`LOGFLARE_*`）與檔案儲存 S3 金鑰
（`S3_PROTOCOL_ACCESS_KEY_*`），並同步更新前端檔案。套件 zip 內附的
`docker/.env.factory` 只是出廠範本，第一次安裝時才複製成 `docker/.env` 並換成
專屬金鑰——所以**每一套安裝的金鑰都不一樣**，別人拿到相同的安裝包也無法連進
你的系統。

- `docker/.env` 和資料庫一樣重要：資料庫密碼和加密金鑰只存在這裡，弄丟了就
  連不上自己的資料。安裝程式每次執行都會把它備份到
  `backups/docker-env-日期-時間.bak`（內容沒變就不重複備份）。搬家或備份伺服器
  時請連同 `backups/` 一起帶走；這些檔案含有密碼，不要外流。

- 安裝完成後**請勿手動修改** `docker/.env` 裡的 `JWT_SECRET` / `ANON_KEY` /
  `SERVICE_ROLE_KEY`（前端已對應安裝時產生的金鑰，改了會連不上）。
- Supabase Studio 管理後台帳密在 `docker/.env`（`DASHBOARD_USERNAME` /
  `DASHBOARD_PASSWORD`；密碼為安裝時隨機產生）。
- 用舊版安裝包裝好的系統：請再執行一次一鍵安裝程式，它會補換成這套安裝專屬的
  檔案儲存 S3 金鑰（舊版沿用公開的出廠值），資料不受影響。

---

## 6. 升級到新版

把新版套件解壓縮到**另一個資料夾**，再把檔案搬進原本的安裝資料夾、重新執行
安裝程式。資料庫、上傳的檔案和這套安裝專屬的金鑰都會保留。

Linux / macOS 安裝程式會自動修正程式檔權限，因此以嚴格的 umask 解壓也可正常安裝；`docker/.env` 仍須維持僅擁有者可讀寫（600）。

1. 新版套件解壓縮到另一個資料夾。新版套件裡沒有 `docker/.env`（只有出廠範本
   `docker/.env.factory`），所以下一步整包複製過去，也不會蓋掉原本那份存著專屬
   金鑰的 `.env`。如果你拿到的套件裡還有 `docker/.env`（較舊的打包方式），
   複製前**先刪掉新版裡的 `docker/.env`**。萬一真的蓋掉了，安裝程式會停下來，
   並告訴你從 `backups/` 的哪個檔案還原。
2. 把新版資料夾裡的全部檔案複製到原本的安裝資料夾，覆蓋同名檔案（建議先刪掉
   原本的 `app/` 資料夾再複製，免得留下舊版的前端檔案；`app/` 裡沒有任何資料）：
   - Linux / macOS：`cp -R 新版資料夾/. 原本的安裝資料夾/`
   - Windows：在檔案總管全選新版資料夾的內容，複製後貼到原本的安裝資料夾，
     選「取代目的地中的檔案」。
3. 在原本的安裝資料夾重新執行安裝程式（`sh install.sh` / 點兩下 `install.bat`）。
   它會：
   - 把新版前端換上這套安裝的金鑰與 API 埠；
   - 重新載入 API 閘道與後端函式；
   - 找出新版新增、還沒套用的**資料庫更新**並列出清單，先把整個資料庫備份到
     `backups/`，你確認後才套用。

資料庫更新只會新增或調整資料表、欄位與權限設定，**不會刪除任何資料**。每個更新
在一個交易裡完成：中途失敗會自動復原，成功的只會套用一次，所以安裝程式可以放心
重複執行。當下選了略過，之後重跑安裝程式會再問一次。

> 備份檔（`backups/livo-db-日期-時間.dump`）是 PostgreSQL 的 `pg_dump` 格式，
> 需要時可以用 `pg_restore` 還原；沒把握的話請先停在這一步、保留備份檔並回報問題。

---

## 7. 用 API 金鑰操作 LIVO

想讓 AI 助理或腳本讀寫 LIVO 的資料（例如自動建立任務、整理清單），不需要給它
伺服器或資料庫的權限，發一把**個人 API 金鑰**就好。

**金鑰的權限等於它綁定的那位成員**：那位成員在網頁上能看、能改什麼，金鑰就能
看、能改什麼，同樣受資料庫的權限規則（RLS）管控。成員被停用、金鑰被撤銷之後
就換不到新的權杖。金鑰不能用來改密碼、Email、登出帳號，也不能建立或撤銷 API
金鑰、重設成員密碼或開通登入帳號——這些都要用網頁登入操作，金鑰外流時才不會
被拿來接管帳號。

### 建議：開一個 AI 專用帳號

不要把金鑰綁在自己的帳號上。另外開一個 AI 專用帳號，只給它需要的角色，之後
在操作歷程裡也看得出哪些是 AI 做的：

1. 到**團隊管理**新增成員，例如「AI 助理」，設定登入密碼。只需要讀寫任務就選
   「成員」；要它管理專案、成員等設定才選「管理員」。
2. 到**系統管理 → 服務整合 → API Tokens → 建立 Token**，取個名字，「綁定成員」
   選這個 AI 帳號。管理員只能綁自己或一般成員；要綁到其他管理員，請超級管理員
   建立。
3. 金鑰（`livo_pat_` 開頭）**只會顯示這一次**，請立刻複製，存進 AI 工具或腳本的
   密鑰設定。弄丟了就撤銷，再建一把新的。

### 換證：用金鑰換一張 15 分鐘的權杖

自架版的資料 API 只認登入權杖，所以先用金鑰換一張 **15 分鐘有效**的權杖，之後
每次呼叫都帶著它；過期（收到 401）就再換一次。需要兩個值：

- `API`：API 閘道網址，預設 `http://localhost:8000`（安裝完成畫面會顯示實際的
  埠；架在正式網域就換成你的網址）。
- `ANON_KEY`：`docker/.env` 裡的 `ANON_KEY`。這是前端本來就公開使用的金鑰，
  不是密碼。

```bash
API=http://localhost:8000
ANON_KEY=貼上 docker/.env 的 ANON_KEY
LIVO_KEY=livo_pat_貼上你的金鑰

TOKEN=$(curl -s -X POST "$API/functions/v1/api-tokens/exchange" \
  -H "Authorization: Bearer $LIVO_KEY" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
```

回應裡有 `access_token`（權杖）、`expires_in`（900 秒）、`expires_at`，以及
`member`（綁定的成員，`member.id` 新增任務時會用到）。

**列出最近 20 筆任務：**

```bash
curl -s "$API/rest/v1/tasks?select=task_key,title,status_id,assignee_id,due_date&order=created_at.desc&limit=20" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $TOKEN"
```

**新增一筆任務：** 先查專案（`/rest/v1/projects?select=id,key,name`）。`id` 用
任何不重複的字串（建議 `t_` 加 UUID），`task_key` 用「專案代碼-下一個號碼」，
`status_id` 的 `s1` 是預設的「待辦」，`creator_id` 填換證回應的 `member.id`。

```bash
curl -s -X POST "$API/rest/v1/tasks" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=representation" \
  -d '{"id":"t_ai_20261001_001","task_key":"PRJ-42","project_id":"專案的 id","title":"整理本週客訴","status_id":"s1","creator_id":"member.id"}'
```

其他資料表（評論、Sprint、專案…）一樣走 `$API/rest/v1/<資料表>`（PostgREST
語法），其他後端函式走 `$API/functions/v1/<名稱>`，都帶同一張權杖。

**安全提醒：**金鑰沒有到期日，請當成密碼保管；不用了就到 API Tokens 撤銷。
清單上的「最近使用」是最後一次換證的時間，可以用來找出沒在用的金鑰。

---

## 8. 團隊功能開關

管理員與超級管理員可到「系統管理 → 功能開關」設定「簽核流程」，套用到全體成員。新安裝預設關閉；升級時如果已存在簽核規則或申請，會保持開啟。既有自架安裝請依上方升級步驟重新執行安裝程式，套用功能開關 migration。

關閉前會列出全部待簽核申請與任務連結。選擇「全部撤回並關閉」會使用一般撤回流程清除任務的待簽核狀態並留下操作紀錄；取消則維持原設定。撤回或儲存失敗時不會關閉，請重新確認清單後重試。

關閉後會隱藏簽核入口、任務欄位、進度、歷史與通知設定，狀態變更也不再送簽核。規則、已撤回申請及其他歷史資料均保留，重新開啟後可查看。設定透過現有 Realtime 即時同步；離線成員會在下次載入時取得設定。功能不需要授權金鑰或任何第三方服務。

## 疑難排解

**Q：安裝程式說「找不到 Docker」或「Docker 尚未啟動」**
請先安裝並啟動 Docker（見第 1 節）。Windows / macOS 開啟 Docker Desktop，
等左下角顯示綠色（Engine running）再重新執行安裝程式。

**Q：連接埠 8000 被占用 / 無法使用**
不用手動處理——安裝程式會自動偵測並繞過。除了被程式占用之外，Windows 上
還有 winnat/Hyper-V 的**系統保留埠段**（不會出現在 netstat，但綁定會失敗，
且每台機器、每次重開機的範圍都可能不同；查詢指令：
`netsh interface ipv4 show excludedportrange protocol=tcp`）。安裝程式對每個
埠做**真實 bind 測試**，8000 無法使用時會自動改用 18000 / 28000 / 38000 /
48000 中第一個可用的埠，並同步更新前端與設定檔（`docker/.env` 的
`KONG_HTTP_PORT`）。使用網址 <http://localhost:3000/demo/> 不受影響；實際
使用的 API 埠會顯示在安裝完成畫面。

**Q：連接埠 3000 被占用**
在 `docker/.env` 加一行 `LIVO_FRONTEND_PORT=3001`（或其他埠），重新執行
安裝程式，之後就改用 <http://localhost:3001/demo/>。

**Q：安裝程式在「等待資料庫就緒」逾時**
- 確認 Docker 分配到至少 4GB RAM（Docker Desktop → Settings → Resources）
- 確認磁碟空間足夠（`df -h` / 檢查 C 槽），可用 `docker system prune` 清理
- 看記錄：`cd docker && docker compose logs --tail=30 db`
- 排除後**重新執行安裝程式**即可

**Q：安裝到一半中斷了（斷電 / 手滑關掉）**
直接重新執行安裝程式。若它偵測到資料庫結構不完整，會詢問是否重置資料庫後
重裝（全新安裝時選 y 即可；若資料庫裡已有重要資料，請不要重置，聯絡我們處理）。

**Q：忘記管理員密碼 / 想再加一個管理員**
重新執行安裝程式，在「建立管理員帳號」步驟輸入該 Email：
- 新 Email → 建立新的管理員
- 既有 Email → 會詢問是否重設密碼

**Q：登入一直失敗 / API 回 401**
多半是安裝完成後有人手動更動了 `docker/.env` 的 `JWT_SECRET` / `ANON_KEY` /
`SERVICE_ROLE_KEY`，導致前端內嵌的金鑰對不上。這些金鑰是安裝時自動產生並與
前端同步的，請不要手動修改；若已經改掉又沒有備份原值，請到 GitHub Issues 回報。

**Q：Realtime（協作編輯）沒作用**
在 Studio（<http://localhost:8000>；若安裝時 API 埠有自動改用備選埠，
請換成該埠）的 SQL Editor 執行以下確認 Realtime 訂閱有開：
```sql
SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime';
```
安裝程式匯入的結構已包含這些設定，正常情況不需額外處理。

**Q：用 API 金鑰換證時回 503**
- `not_installed`：資料庫還沒套用 API 金鑰的資料表更新。重新執行安裝程式，在
  「資料庫更新」步驟選 Y。
- `gateway_not_hardened`：API 閘道還是舊版設定，系統不敢發出權杖。確認
  `docker/volumes/api/kong.yml` 已換成新版（見「升級到新版」），再重新執行安裝
  程式。

**Q：用 API 金鑰換證時回 401 或 403**
401 是金鑰錯誤或已撤銷；403 是綁定的成員已停用，或那位成員還沒有登入帳號。

---

## 附錄：手動安裝（進階；一鍵安裝無法使用時才需要）

<details>
<summary>展開手動安裝步驟</summary>

> ⚠️ **手動安裝不會更換出廠預設金鑰**（一鍵安裝才會產生每套安裝專屬的
> JWT 金鑰與密碼），也**不會自動處理連接埠問題**（Windows 系統保留埠段
> 蓋到 8000 時，`docker compose up` 會直接失敗）。手動安裝的系統若對外
> 開放，任何拿到相同安裝包的人都知道你的金鑰。強烈建議即使手動裝好了，
> 也再執行一次一鍵安裝程式（可重複執行，會補上專屬金鑰）。

### A. 啟動服務

```bash
cd docker
docker compose -f docker-compose.yml -f compose.frontend.yml up -d
docker compose ps   # 等所有服務 Up / healthy
```

### B. 匯入資料庫結構

1. 瀏覽器打開 **Supabase Studio**：<http://localhost:8000>
2. 用 `docker/.env` 裡的 `DASHBOARD_USERNAME` / `DASHBOARD_PASSWORD` 登入
   （一鍵安裝後密碼為隨機產生；未跑過一鍵安裝時是出廠預設值，系統對外開放前務必更換）
3. 左側選單點 **SQL Editor** → **New query**
4. 打開套件內的 `schema/livo-schema.sql`，**全選複製**貼進編輯器 → 按 **Run**
5. 若套件內有 `schema/first-run.sql`，同樣方式執行一次

### C. 建立第一個管理員帳號

1. 在 Studio 左側選 **Authentication → Users → Add user**，填入 Email 和
   Password（套件預設已開啟自動確認，不需收驗證信）
2. 回到 **SQL Editor**，執行以下 SQL（把 `<AUTH_USER_ID>`、`<EMAIL>`、`<NAME>`
   換成實際值；UUID 在 Users 頁面點該使用者即可看到）：

```sql
INSERT INTO members (id, name, avatar, role, job_title, color, email, auth_id, is_active, sort_order)
VALUES (
  gen_random_uuid()::text,
  '<NAME>',
  substr('<NAME>', 1, 2),
  'super_admin',
  '系統管理員',
  '#0052CC',
  '<EMAIL>',
  '<AUTH_USER_ID>',
  true,
  0
);
```

> 之後要新增其他成員，直接在 LIVO 系統內的「成員管理」操作即可，不必再手動下 SQL。

### D. 前端

前端容器（`livo-frontend`）已隨 A 步驟啟動，網址 <http://localhost:3000/demo/>。
若你偏好不用容器跑前端，也可以在 `app/` 目錄用 Node.js 18+ 執行
`node server.cjs`（預設連接埠 4321，`PORT=8080 node server.cjs` 可改）。

</details>

---

## 需要協助？

請到 <https://github.com/livo-tw/livo/issues> 回報問題。


## 從 Slack 建卡與留言（Docker，可選，預設關閉）

管理員先在「系統管理 → 功能開關」開啟「Slack 互動（建卡、留言）」，再到「整合 → Slack」設定。
功能關閉時不顯示互動設定、不處理建卡或留言，已存設定、綁定及紀錄仍保留。Cloudflare 版不提供此功能；展示模式不連線。
Socket Mode 由容器主動連到 Slack，公司內網不必提供公開 Request URL。Slack 仍須允許容器對外 HTTPS / WebSocket 連線。

1. 在 Slack App 的 **Socket Mode** 開啟連線；於 **Basic Information → App-level tokens** 建立具有 `connections:write` 的 Token。
2. 新增 `/livo` slash command；啟用 **Interactivity**，新增兩個 **message shortcuts**：
   - 「建立 LIVO 卡片」，callback ID：`livo_create_task`。
   - 「留言到 LIVO 卡片」，callback ID：`livo_comment_task`。
3. Bot scopes 加入 `commands`，並保留通知功能所需的 `channels:read`、`groups:read`、`chat:write`、`chat:write.customize`、`im:write`、`users:read`、`users:read.email`；重新安裝 App。
4. 在 LIVO Slack 卡片連接 Bot Token，將 Bot 邀請進預計操作的頻道。
5. 在安裝目錄的 `docker/.env` 設定 `SLACK_APP_TOKEN=xapp-example`，以及同事可開啟的 `APP_BASE_URL=https://livo.example.com`（主機根網址，不含 /demo）。
6. 重跑 `sh install.sh` 或 `install.bat`。安裝程式會備份既有 .env，只在缺少時產生 `SLACK_INTERNAL_SECRET`，重跑保留既有密鑰。進入 docker 目錄執行：

```sh
docker compose -f docker-compose.yml -f compose.frontend.yml up -d
```

「從 Slack 建卡與留言」區塊會顯示 relay 狀態（每 30 秒回報，超過 90 秒未回報視為離線）、綁定帳號及解除綁定按鈕。
未設定 App Token 的 relay 會安靜退出，不影響原有服務。Bot Token 留在伺服器；App Token 只交給 relay，內部共享密鑰不會顯示在 UI。

- `/livo` 或 `/livo new 標題`：開啟建卡表單；經辦人預設為本人。
- `/livo comment ABC-123 留言內容`：在卡片留言；不附內容時開啟表單。
- `/livo help`：查看操作方式。
- 訊息捷徑帶入原訊息及 permalink；留言捷徑可搜尋有權限看到的卡片（最多 20 筆），已對應卡片的討論串會預選卡片。

首次使用依 Slack Email（不分大小寫）綁定唯一、已啟用且具登入帳號的 LIVO 成員。若尚未建立登入帳號，請先由管理員啟用帳號並完成一次登入。
找不到、重複 Email 或停用帳號不會建立卡片／留言。解除綁定保留操作歷史，下次使用重新驗證 Email。
搜尋、建卡及留言使用該成員的 authenticated 身分與既有 RLS；提交時再次檢查功能開關、綁定及啟用狀態。
卡號依專案編號，重送不重複建立；留言、計數、站內通知、活動紀錄與操作紀錄同一交易提交。
若團隊另有這份表單未提供的必填欄位，會引導回 LIVO 網頁建卡。關閉功能不會取消已完成的操作。

Slack 文字會安全轉為留言格式；已綁定的 @提及保留 LIVO 通知。Slack 來源留言不再向來源頻道發送「新留言」通知；其他頻道及個人通知仍依原設定發送。
Email 與簽名 webhook 沿用資料庫通知觸發器。Slack 通知失敗不會撤銷已儲存的卡片／留言。
此版不會自動同步每一則討論串回覆，不讀取頻道歷史，也不匯入 Slack 附件。
Socket Mode 協定參考：[Slack 官方文件](https://docs.slack.dev/apis/events-api/using-socket-mode/)。
