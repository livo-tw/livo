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
│   ├── .env                     ← 出廠預設值（安裝時會自動換成本安裝專屬金鑰）
│   └── volumes/                 ← 各服務設定檔（不含任何資料，全新安裝）
└── schema/
    ├── livo-schema.sql          ← 資料庫結構（安裝程式會自動匯入）
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

> 安裝程式**可以重複執行**：已完成的步驟會自動略過。安裝中斷（斷電、按到
> Ctrl+C）也沒關係，重新執行一次即可。之後想再建管理員或重設管理員密碼，
> 也是重新執行安裝程式。

---

## 4. 日常維運

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
然後重新執行安裝程式（或重新 `up -d`）。

**架在正式網域（Slack 通知連結）**：Slack 通知裡的任務連結會用
`docker/.env` 的 `APP_BASE_URL`（預設 `http://localhost:3000`）組網址。
若 LIVO 架在正式網域，請把它改成實際網址（例如 `https://pm.example.com`，
不含結尾斜線），再到 `docker/` 執行 `docker compose up -d` 重新載入。

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
`docker/.env` 只是出廠預設值，安裝完成後就會被換掉——所以**每一套安裝的金鑰
都不一樣**，別人拿到相同的安裝包也無法連進你的系統。

- 安裝完成後**請勿手動修改** `docker/.env` 裡的 `JWT_SECRET` / `ANON_KEY` /
  `SERVICE_ROLE_KEY`（前端已對應安裝時產生的金鑰，改了會連不上）。
- Supabase Studio 管理後台帳密在 `docker/.env`（`DASHBOARD_USERNAME` /
  `DASHBOARD_PASSWORD`；密碼為安裝時隨機產生）。
- 用舊版安裝包裝好的系統：請再執行一次一鍵安裝程式，它會補換成這套安裝專屬的
  檔案儲存 S3 金鑰（舊版沿用公開的出廠值），資料不受影響。

---

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
