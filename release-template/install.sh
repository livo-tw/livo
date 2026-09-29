#!/bin/sh
# ============================================================
#  LIVO 自架版 一鍵安裝（Linux / macOS）
#
#  用法：在套件根目錄執行
#      sh install.sh
#
#  本程式可重複執行：已完成的步驟會自動略過。
# ============================================================

# ---------- 路徑與常數 ----------
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
DOCKER_DIR="$ROOT/docker"
SCHEMA_FILE="$ROOT/schema/livo-schema.sql"
FIRSTRUN_FILE="$ROOT/schema/first-run.sql"
ADMIN_SQL="$ROOT/installer/create-admin.sql"
KEYGEN_JS="$ROOT/installer/generate-keys.js"
ENV_FILE="$DOCKER_DIR/.env"
KONG_YML="$DOCKER_DIR/volumes/api/kong.yml"
FRONTEND_PORT_DEFAULT=3000
SUPPORT="遇到問題？請到 https://github.com/livo-tw/livo/issues 回報。"

# 前端 bundle 內嵌 anon key 的固定前綴（HS256 JWT header + {"role":"anon" 開頭
# 的 payload）。generate-keys.js 保證新 key 也有同樣前綴，因此重跑安裝時
# 一樣找得到、換得掉（自我修復，不依賴 .env 舊值）。
ANON_JWT_RE='eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJyb2xlIjoiYW5vbiI[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*'

say() { printf '%s\n' "$*"; }
hr()  { say "------------------------------------------------------------"; }

die() {
  hr
  say "[X] $1"
  [ -n "$2" ] && say "$2"
  say ""
  say "$SUPPORT"
  exit 1
}

# docker compose（固定帶前端 overlay；一律在 docker/ 目錄下執行）
dc() { (cd "$DOCKER_DIR" && docker compose -f docker-compose.yml -f compose.frontend.yml "$@"); }

# 單行 SQL 查詢（回傳結果字串；失敗回空字串）
# </dev/null 必加：docker exec -T 會把本腳本的 stdin 整段吸進容器（即使 psql -c
# 根本不讀），互動輸入（管理員 Email/密碼）會被吃掉、read 卡 EOF 空轉。
psql_c() { dc exec -T db psql -U supabase_admin -h localhost -d postgres -tA -c "$1" </dev/null 2>/dev/null; }

# 把 SQL 檔灌進資料庫（ON_ERROR_STOP，任何錯誤即失敗）
psql_file() { dc exec -T db psql -U supabase_admin -h localhost -d postgres -q -v ON_ERROR_STOP=1 < "$1"; }

esc_sql() { printf '%s' "$1" | sed "s/'/''/g"; }

json_field() { # $1=json $2=key（值保證不含引號/反斜線，直接用 sed 取出）
  printf '%s' "$1" | sed -n "s/.*\"$2\":\"\([^\"]*\)\".*/\1/p"
}

set_env_var() { # $1=key $2=value（改寫 docker/.env；不存在則附加）
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i.bak "s|^$1=.*|$1=$2|" "$ENV_FILE" && rm -f "$ENV_FILE.bak"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}

env_var() { # $1=key → 取 docker/.env 中的值（無則空字串）
  grep -E "^$1=" "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '[:space:]'
}

# 自訂前端 port（docker/.env 可設 LIVO_FRONTEND_PORT）
FRONTEND_PORT=$FRONTEND_PORT_DEFAULT
if [ -f "$DOCKER_DIR/.env" ]; then
  _p=$(grep -E '^LIVO_FRONTEND_PORT=' "$DOCKER_DIR/.env" | tail -1 | cut -d= -f2 | tr -d '[:space:]')
  [ -n "$_p" ] && FRONTEND_PORT=$_p
fi

say "=============================================================="
say "  LIVO 自架版 一鍵安裝"
say "=============================================================="

[ -f "$DOCKER_DIR/docker-compose.yml" ] || die "找不到 docker/docker-compose.yml。" "請先把整個套件解壓縮，並在套件根目錄執行：sh install.sh"
[ -f "$DOCKER_DIR/compose.frontend.yml" ] || die "找不到 docker/compose.frontend.yml。" "套件不完整，請重新解壓縮。"
[ -f "$SCHEMA_FILE" ] || die "找不到 schema/livo-schema.sql。" "套件不完整，請重新解壓縮。"
[ -f "$ADMIN_SQL" ] || die "找不到 installer/create-admin.sql。" "套件不完整，請重新解壓縮。"

# ============================================================
# [1/7] 環境檢查
# ============================================================
say ""
say "[1/7] 檢查環境..."

OS=$(uname -s 2>/dev/null || echo unknown)

if ! command -v docker >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    die "找不到 Docker。" "請先安裝 Docker Desktop（macOS）：
  https://www.docker.com/products/docker-desktop/
安裝並啟動 Docker Desktop 後，再重新執行：sh install.sh"
  else
    die "找不到 Docker。" "請先安裝 Docker（Linux 一行指令）：
  curl -fsSL https://get.docker.com | sh
安裝後啟動服務：sudo systemctl enable --now docker
再重新執行：sh install.sh"
  fi
fi

if ! docker info >/dev/null 2>&1; then
  if [ "$OS" = "Darwin" ]; then
    die "Docker 尚未啟動。" "請開啟 Docker Desktop，等它左下角顯示綠色（Engine running）後，
再重新執行：sh install.sh"
  else
    die "Docker 尚未啟動或沒有權限。" "請先確認：
  1. Docker 服務已啟動：sudo systemctl start docker
  2. 若錯誤訊息是 permission denied：
     把使用者加入 docker 群組：sudo usermod -aG docker \$USER
     （重新登入後生效），或改用：sudo sh install.sh"
  fi
fi

if ! docker compose version >/dev/null 2>&1; then
  if command -v docker-compose >/dev/null 2>&1; then
    die "偵測到舊版 docker-compose（v1），本套件需要 Docker Compose v2。" "請升級 Docker：
  macOS：更新 Docker Desktop 至最新版
  Linux：sudo apt-get install docker-compose-plugin（Debian/Ubuntu）
         或 sudo yum install docker-compose-plugin（RHEL/CentOS）"
  else
    die "找不到 Docker Compose v2。" "請升級 Docker Desktop 至最新版（macOS），
或安裝 compose plugin（Linux）：sudo apt-get install docker-compose-plugin"
  fi
fi
say "  [OK] Docker / Docker Compose v2"

# ---- 連接埠檢查（真實 bind 測試）----
# netstat/lsof/ss 只能看到「有人在 LISTEN」的埠。Windows 的 winnat/Hyper-V
# 「保留埠段」不會 LISTEN、查不到，但 bind 一樣會失敗（docker compose up 直接
# 死在 Ports are not available）。因此改用 docker 實際發布埠來測——跨平台
# 行為一致，連保留埠段也抓得到。
# 查保留埠段（Windows）：netsh interface ipv4 show excludedportrange protocol=tcp
RUNNING_NAMES=$(docker ps --format '{{.Names}}' 2>/dev/null)
has_container() { printf '%s\n' "$RUNNING_NAMES" | grep -qx "$1"; }

# 測試用迷你映像檔（重置資料庫時也會用到 alpine）；抓不到就略過埠檢查，
# 交給 compose up 時報錯（第一次安裝本來就需要網路抓映像檔）。
BINDTEST_OK=1
if ! docker image inspect alpine >/dev/null 2>&1; then
  docker pull -q alpine </dev/null >/dev/null 2>&1 || BINDTEST_OK=""
fi

port_bindable() { # $1=port → 0 可用 / 非 0 不可用（被占用或被系統保留）
  [ -n "$BINDTEST_OK" ] || return 0   # 無法測試時放行
  docker run --rm -p "$1:80" alpine true </dev/null >/dev/null 2>&1
}

[ -n "$BINDTEST_OK" ] || say "  [!] 無法下載連接埠測試映像檔，略過埠檢查（啟動時若埠衝突會再回報）。"

# --- Kong（API 閘道）HTTP 埠：預設 8000；無法使用時自動改用備選埠 ---
KONG_PORT=$(env_var KONG_HTTP_PORT)
[ -n "$KONG_PORT" ] || KONG_PORT=8000

if has_container supabase-kong; then
  :   # kong 已在執行（重跑安裝），這個埠必然可用
elif port_bindable "$KONG_PORT"; then
  :
else
  say "  [!] 連接埠 $KONG_PORT 無法使用（被其他程式占用，或落在 Windows 系統保留埠段）。"
  PICKED=""
  for _cand in 18000 28000 38000 48000; do
    if port_bindable "$_cand"; then PICKED=$_cand; break; fi
  done
  [ -n "$PICKED" ] || die "找不到可用的 API 閘道連接埠。" "8000 / 18000 / 28000 / 38000 / 48000 全部無法使用。
請關閉占用這些埠的程式後重新執行：sh install.sh
（Windows 查保留埠段：netsh interface ipv4 show excludedportrange protocol=tcp）"
  say "      已自動改用連接埠 $PICKED（前端會同步更新，使用網址不變）。"
  KONG_PORT=$PICKED
fi

# 讓 docker/.env 與前端 bundle 都對齊選定的 kong 埠。
# 冪等：.env 的 LIVO_KONG_PORT_PATCHED 記錄「bundle 目前引用的埠」（出廠為
# 8000），重跑時從那個值換到新值，不會重複改壞。
apply_kong_port() {
  _bundle_port=$(env_var LIVO_KONG_PORT_PATCHED)
  [ -n "$_bundle_port" ] || _bundle_port=8000

  set_env_var KONG_HTTP_PORT "$KONG_PORT"
  # SUPABASE_PUBLIC_URL / API_EXTERNAL_URL 出廠指向 localhost:<kong 埠>；
  # 只在仍是 localhost 預設值時跟著改（不動客戶自訂的網域）
  for _var in SUPABASE_PUBLIC_URL API_EXTERNAL_URL; do
    case "$(env_var "$_var")" in
      http://localhost:[0-9]*) set_env_var "$_var" "http://localhost:$KONG_PORT" ;;
    esac
  done

  if [ "$_bundle_port" != "$KONG_PORT" ]; then
    _patched=0
    for f in "$ROOT/app/demo/assets"/*.js "$ROOT/app"/*.js; do
      [ -f "$f" ] || continue
      if grep -qF "localhost:$_bundle_port" "$f"; then
        sed -i.bak "s|localhost:$_bundle_port|localhost:$KONG_PORT|g" "$f" && rm -f "$f.bak"
        _patched=$((_patched + 1))
      fi
    done
    say "  [OK] API 閘道改用連接埠 $KONG_PORT（前端已同步更新 $_patched 個檔案）"
  fi
  set_env_var LIVO_KONG_PORT_PATCHED "$KONG_PORT"
}
apply_kong_port

# --- 前端埠 / HTTPS 埠：真實 bind 測試 + 原本的改埠指引 ---
PORT_FAIL=""
if has_container livo-frontend || port_bindable "$FRONTEND_PORT"; then
  :
else
  say "  [!] 連接埠 $FRONTEND_PORT 無法使用（LIVO 前端；被占用或被系統保留）。"
  say "      可改用其他埠：在 docker/.env 加一行 LIVO_FRONTEND_PORT=3001，再重新執行安裝。"
  PORT_FAIL=1
fi

# （kong HTTPS 埠與資料庫連線池都不再對外發布——8443 上本來就沒設 TLS 憑證、
#   沒有任何服務；DB 走 docker exec / 容器內網。少開埠 = 少一種裝不起來的方式。）

[ -n "$PORT_FAIL" ] && die "有連接埠無法使用，無法啟動。" "請依上方指示處理後，重新執行：sh install.sh
（占用查詢：lsof -i :3000（macOS/Linux）；Windows 保留埠段：
  netsh interface ipv4 show excludedportrange protocol=tcp）"

say "  [OK] 連接埠檢查通過（API 閘道：$KONG_PORT）"

# ============================================================
# [2/7] 產生本安裝專屬金鑰
# ============================================================
# 出廠 zip 內的 docker/.env 只是預設值：每一套安裝都會在這裡換成
# 自己專屬的 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY / 資料庫密碼 /
# 後台密碼，並同步改寫前端 bundle 內嵌的 anon key。
# 冪等：.env 內出現 LIVO_KEYS_ROTATED=1 即略過（重跑不會作廢現有安裝）。

rotate_keys() {
  if grep -q '^LIVO_KEYS_ROTATED=1' "$ENV_FILE" 2>/dev/null; then
    say "  [OK] 本安裝已有專屬金鑰（先前產生過，略過）"
    return 0
  fi
  if [ -d "$DOCKER_DIR/volumes/db/data" ]; then
    say "  [!] 偵測到既有資料庫、但尚未產生專屬金鑰（可能是舊版安裝）。"
    say "      為避免破壞現有安裝，略過金鑰更換；建議聯絡我們協助升級金鑰。"
    return 0
  fi
  [ -f "$KEYGEN_JS" ] || die "找不到 installer/generate-keys.js。" "套件不完整，請重新解壓縮。"

  say "  產生本安裝專屬金鑰（第一次需下載小型工具映像檔）..."
  KEYS_JSON=$(docker run --rm -i node:20-alpine node - < "$KEYGEN_JS")
  [ -n "$KEYS_JSON" ] || die "金鑰產生失敗（docker run node:20-alpine）。" "請確認這台機器可以連外網下載映像檔後，重新執行：sh install.sh"

  NEW_JWT=$(json_field "$KEYS_JSON" JWT_SECRET)
  NEW_ANON=$(json_field "$KEYS_JSON" ANON_KEY)
  NEW_SERVICE=$(json_field "$KEYS_JSON" SERVICE_ROLE_KEY)
  NEW_PGPASS=$(json_field "$KEYS_JSON" POSTGRES_PASSWORD)
  NEW_DASH=$(json_field "$KEYS_JSON" DASHBOARD_PASSWORD)
  if [ -z "$NEW_JWT" ] || [ -z "$NEW_ANON" ] || [ -z "$NEW_SERVICE" ] || [ -z "$NEW_PGPASS" ] || [ -z "$NEW_DASH" ]; then
    die "金鑰產生結果不完整。" "請重新執行 sh install.sh；若持續失敗請聯絡我們。"
  fi
  # 各服務內部加密金鑰（出廠值是公開的，一定要換；storage S3 金鑰見 rotate_s3_keys）
  INTERNAL_KEYS="SECRET_KEY_BASE VAULT_ENC_KEY PG_META_CRYPTO_KEY LOGFLARE_PUBLIC_ACCESS_TOKEN LOGFLARE_PRIVATE_ACCESS_TOKEN"
  for k in $INTERNAL_KEYS; do
    [ -n "$(json_field "$KEYS_JSON" "$k")" ] || die "金鑰產生結果不完整（$k）。" "請重新執行 sh install.sh；若持續失敗請聯絡我們。"
  done

  # 記下 .env 目前的（舊）金鑰，稍後用來清掉任何殘留引用
  OLD_ENV_ANON=$(grep -E '^ANON_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)
  OLD_ENV_SERVICE=$(grep -E '^SERVICE_ROLE_KEY=' "$ENV_FILE" | tail -1 | cut -d= -f2-)

  # 1) 改寫 docker/.env
  set_env_var JWT_SECRET "$NEW_JWT"
  set_env_var ANON_KEY "$NEW_ANON"
  set_env_var SERVICE_ROLE_KEY "$NEW_SERVICE"
  set_env_var POSTGRES_PASSWORD "$NEW_PGPASS"
  set_env_var DASHBOARD_PASSWORD "$NEW_DASH"
  for k in $INTERNAL_KEYS; do
    set_env_var "$k" "$(json_field "$KEYS_JSON" "$k")"
  done

  # 2) 改寫前端 bundle 內嵌的 anon key（從 bundle 本身找出目前的 key）
  EMBEDDED_ANON=""
  for f in "$ROOT/app/demo/assets"/*.js; do
    [ -f "$f" ] || continue
    EMBEDDED_ANON=$(grep -ohE "$ANON_JWT_RE" "$f" 2>/dev/null | head -1)
    [ -n "$EMBEDDED_ANON" ] && break
  done
  [ -n "$EMBEDDED_ANON" ] || die "在前端檔案中找不到內嵌的 API 金鑰。" "套件可能不完整，請重新解壓縮後再執行：sh install.sh"
  PATCHED=0
  for f in "$ROOT/app/demo/assets"/*.js "$ROOT/app"/*.js; do
    [ -f "$f" ] || continue
    if grep -qF "$EMBEDDED_ANON" "$f"; then
      sed -i.bak "s|$EMBEDDED_ANON|$NEW_ANON|g" "$f" && rm -f "$f.bak"
      PATCHED=$((PATCHED + 1))
    fi
  done

  # 3) 保險：kong.yml 正常只引用環境變數；若有人把金鑰寫死進去，一併更換
  if [ -f "$KONG_YML" ]; then
    for old in "$EMBEDDED_ANON" "$OLD_ENV_ANON"; do
      [ -n "$old" ] || continue
      if grep -qF "$old" "$KONG_YML"; then
        sed -i.bak "s|$old|$NEW_ANON|g" "$KONG_YML" && rm -f "$KONG_YML.bak"
      fi
    done
    if [ -n "$OLD_ENV_SERVICE" ] && grep -qF "$OLD_ENV_SERVICE" "$KONG_YML"; then
      sed -i.bak "s|$OLD_ENV_SERVICE|$NEW_SERVICE|g" "$KONG_YML" && rm -f "$KONG_YML.bak"
    fi
  fi

  # 4) 寫入完成標記（重跑安裝不會再換金鑰）
  {
    printf '\n# 安裝程式已產生本機專屬金鑰（請勿手動更改 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY）\n'
    printf 'LIVO_KEYS_ROTATED=1\n'
  } >> "$ENV_FILE"

  say "  [OK] 已產生本安裝專屬金鑰（前端已同步更新 $PATCHED 個檔案）"
}

# 檔案儲存（storage）的 S3 金鑰。舊版安裝程式沒有換它，出廠值又是公開的上游
# 預設值：連得到 API 閘道的人就能用它讀寫所有上傳檔。storage 只從環境變數讀
# 這組金鑰、不留衍生資料，所以已經在用的安裝也能安全更換（下一步 up -d 會帶
# 新值重建 storage 容器）。和 rotate_keys 分開標記：舊版安裝重跑也會補換。
# 冪等：.env 內出現 LIVO_S3_KEYS_ROTATED=1 即略過。
rotate_s3_keys() {
  if grep -q '^LIVO_S3_KEYS_ROTATED=1' "$ENV_FILE" 2>/dev/null; then
    return 0
  fi
  [ -f "$KEYGEN_JS" ] || die "找不到 installer/generate-keys.js。" "套件不完整，請重新解壓縮。"
  if [ -z "${KEYS_JSON:-}" ]; then
    KEYS_JSON=$(docker run --rm -i node:20-alpine node - < "$KEYGEN_JS")
  fi
  NEW_S3_ID=$(json_field "$KEYS_JSON" S3_PROTOCOL_ACCESS_KEY_ID)
  NEW_S3_SECRET=$(json_field "$KEYS_JSON" S3_PROTOCOL_ACCESS_KEY_SECRET)
  if [ -z "$NEW_S3_ID" ] || [ -z "$NEW_S3_SECRET" ]; then
    die "檔案儲存金鑰產生失敗（docker run node:20-alpine）。" "請確認這台機器可以連外網下載映像檔後，重新執行：sh install.sh"
  fi
  set_env_var S3_PROTOCOL_ACCESS_KEY_ID "$NEW_S3_ID"
  set_env_var S3_PROTOCOL_ACCESS_KEY_SECRET "$NEW_S3_SECRET"
  printf '\nLIVO_S3_KEYS_ROTATED=1\n' >> "$ENV_FILE"
  say "  [OK] 已產生本安裝專屬的檔案儲存 S3 金鑰"
}

say ""
say "[2/7] 產生本安裝專屬金鑰..."
rotate_keys
rotate_s3_keys

# ============================================================
# [3/7] 啟動服務
# ============================================================
say ""
say "[3/7] 啟動後端與前端服務（第一次執行需下載映像檔，約 5-10 分鐘）..."
if ! dc up -d </dev/null; then
  die "docker compose 啟動失敗。" "常見原因：
  1. 網路無法下載映像檔：請確認這台機器可以連外網
  2. 磁碟空間不足：df -h 檢查，docker system prune 清理
  3. 連接埠衝突：看上方錯誤訊息中的 port 編號
詳細記錄：cd docker && docker compose -f docker-compose.yml -f compose.frontend.yml logs --tail=50
排除後重新執行：sh install.sh"
fi
say "  [OK] 服務已啟動"

# ============================================================
# [4/7] 等待資料庫就緒
# ============================================================
wait_db() {
  printf "[4/7] 等待資料庫就緒（最多 3 分鐘）"
  _i=0
  while [ "$_i" -lt 90 ]; do
    if dc exec -T db pg_isready -U postgres -h localhost </dev/null >/dev/null 2>&1; then
      say ""
      say "  [OK] 資料庫已就緒"
      return 0
    fi
    printf "."
    sleep 2
    _i=$((_i + 1))
  done
  say ""
  say "  資料庫在 180 秒內沒有就緒。最近 30 行資料庫記錄："
  hr
  dc logs --tail=30 db </dev/null
  hr
  die "資料庫啟動逾時。" "常見原因與解法：
  1. 記憶體不足：Docker 至少需要 4GB RAM
     （Docker Desktop → Settings → Resources 調高記憶體）
  2. 磁碟已滿：df -h 檢查剩餘空間，docker system prune 清理
  3. 連接埠衝突：上方記錄若出現 address already in use，請處理該埠
排除後重新執行 sh install.sh 即可（安裝程式可重複執行）。"
}

# 等 auth / storage / realtime 完成各自的資料庫初始化
wait_backend_ready() {
  printf "      等待後端服務初始化（auth / storage / realtime）"
  _sql="SELECT (to_regclass('auth.users') IS NOT NULL) AND (to_regclass('storage.buckets') IS NOT NULL) AND (EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime'))"
  _i=0
  while [ "$_i" -lt 90 ]; do
    [ "$(psql_c "$_sql")" = "t" ] && { say ""; say "  [OK] 後端服務初始化完成"; return 0; }
    printf "."
    sleep 2
    _i=$((_i + 1))
  done
  say ""
  say "  以下服務尚未完成初始化："
  [ "$(psql_c "SELECT to_regclass('auth.users') IS NOT NULL")" = "t" ]      || say "    - auth（帳號系統）    記錄：docker compose logs --tail=20 auth"
  [ "$(psql_c "SELECT to_regclass('storage.buckets') IS NOT NULL")" = "t" ] || say "    - storage（檔案系統）  記錄：docker compose logs --tail=20 storage"
  [ "$(psql_c "SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')")" = "t" ] || say "    - realtime（協作同步） 記錄：docker compose logs --tail=20 realtime"
  die "後端服務初始化逾時。" "請到 docker/ 目錄執行上列 logs 指令查看原因（多半是記憶體不足），
排除後重新執行：sh install.sh"
}

wait_db
wait_backend_ready

# ============================================================
# [5/7] 建立資料庫結構
# ============================================================
say ""
say "[5/7] 建立資料庫結構..."

write_marker() {
  psql_c "CREATE TABLE IF NOT EXISTS public.livo_install_state (key text PRIMARY KEY, value text, updated_at timestamptz NOT NULL DEFAULT now())" >/dev/null
  psql_c "ALTER TABLE public.livo_install_state ENABLE ROW LEVEL SECURITY" >/dev/null
  psql_c "INSERT INTO public.livo_install_state (key, value) VALUES ('schema_applied','1') ON CONFLICT (key) DO UPDATE SET value='1', updated_at=now()" >/dev/null
}

apply_schema() {
  say "  套用資料庫結構（約 1 分鐘）..."
  if ! psql_file "$SCHEMA_FILE"; then
    die "資料庫結構建立失敗。" "請截圖上方錯誤訊息。你可以：
  1. 重新執行 sh install.sh，選擇「重置資料庫」再試一次
  2. 或聯絡我們協助處理"
  fi
  write_marker
  say "  [OK] 資料庫結構建立完成"
}

reset_database() {
  say "  正在重置資料庫（停止服務、刪除資料、重新啟動）..."
  dc down -v </dev/null >/dev/null 2>&1
  rm -rf "$DOCKER_DIR/volumes/db/data" 2>/dev/null
  if [ -d "$DOCKER_DIR/volumes/db/data" ]; then
    # Linux 上資料目錄是 root 擁有，一般使用者刪不掉 → 借 Docker 代刪
    docker run --rm -v "$DOCKER_DIR/volumes/db:/livo-db" alpine \
      sh -c 'rm -rf /livo-db/data' >/dev/null 2>&1
  fi
  if [ -d "$DOCKER_DIR/volumes/db/data" ]; then
    die "無法刪除資料庫資料目錄。" "請手動刪除以下資料夾後重新執行 sh install.sh：
  $DOCKER_DIR/volumes/db/data
（Linux 可用：sudo rm -rf 上述路徑）"
  fi
  # 資料已清空：若這套安裝還沒有專屬金鑰（舊版安裝升級），現在補產生
  rotate_keys
  if ! dc up -d </dev/null; then
    die "重置後重新啟動失敗。" "請重新執行：sh install.sh"
  fi
  wait_db
  wait_backend_ready
}

# 狀態偵測分兩步：不能在同一句 SQL 裡 SELECT 一張「可能不存在」的表——
# PostgreSQL 在解析期就會報 relation does not exist（CASE 只短路執行、
# 不短路解析），全新資料庫會整句失敗。先查表存在與否，存在才查內容。
TBLS=$(psql_c "SELECT (to_regclass('public.livo_install_state') IS NOT NULL)::text
  || ',' || (to_regclass('public.standup_sessions') IS NOT NULL)::text
  || ',' || (to_regclass('public.members') IS NOT NULL)::text")
case "$TBLS" in
  true,*)
    MARK=$(psql_c "SELECT EXISTS (SELECT 1 FROM public.livo_install_state WHERE key='schema_applied')::text")
    if [ "$MARK" = "true" ]; then STATE=applied; else STATE=partial; fi
    ;;
  false,true,true) STATE=legacy ;;
  false,*,true)    STATE=partial ;;
  false,*,false)   STATE=fresh ;;
  *)               STATE="" ;;  # 連線失敗（查詢無輸出）
esac

case "$STATE" in
  applied)
    say "  資料庫已初始化，略過。"
    ;;
  legacy)
    say "  偵測到既有的 LIVO 資料庫（先前手動安裝完成），略過建立。"
    write_marker
    ;;
  partial)
    say "  [!] 資料庫結構不完整（可能上次安裝中斷）。"
    printf "  要重置資料庫重新安裝嗎？資料庫內所有資料將被刪除！[y/N] "
    read -r ANS || ANS=n
    case "$ANS" in
      y|Y|yes|YES)
        reset_database
        apply_schema
        ;;
      *)
        die "已取消安裝。" "若這個資料庫裡有重要資料，請不要重置，聯絡我們協助處理。"
        ;;
    esac
    ;;
  fresh)
    apply_schema
    ;;
  *)
    die "無法確認資料庫狀態（連線失敗）。" "請稍等 1 分鐘後重新執行：sh install.sh
若持續失敗，到 docker/ 目錄執行：docker compose logs --tail=30 db"
    ;;
esac

# ---- first-run.sql（預設狀態、移除示範資料；冪等）----
if [ -f "$FIRSTRUN_FILE" ]; then
  say "  套用初始化設定（first-run.sql）..."
  if psql_file "$FIRSTRUN_FILE"; then
    say "  [OK] 初始化設定完成"
  else
    say "  [!] first-run.sql 執行有誤（不影響主要功能）。請截圖上方訊息並聯絡我們。"
  fi
fi

# ---- 授權重置碼（每套安裝唯一；已設定過則沿用既有的）----
# reset_license() 會比對 system_settings key='license_reset_code'。
# ON CONFLICT DO NOTHING → 重跑安裝不會改掉已存在的重置碼。
RESET_CODE=""
seed_reset_code() {
  _rand=$(LC_ALL=C tr -dc 'A-Z0-9' < /dev/urandom 2>/dev/null | head -c 8)
  if [ -z "$_rand" ]; then
    say "  [!] 無法產生亂數，略過授權重置碼設定（可稍後聯絡我們補設）。"
    return 0
  fi
  psql_c "INSERT INTO public.system_settings (key, value) VALUES ('license_reset_code', to_jsonb('LIVO-RESET-${_rand}'::text)) ON CONFLICT (key) DO NOTHING" >/dev/null
  RESET_CODE=$(psql_c "SELECT value #>> '{}' FROM public.system_settings WHERE key = 'license_reset_code'")
  if [ -n "$RESET_CODE" ]; then
    say "  [OK] 授權重置碼已設定"
  else
    say "  [!] 無法設定授權重置碼（不影響主要功能）。請截圖上方訊息並聯絡我們。"
  fi
}

# ============================================================
# [6/7] 建立管理員帳號
# ============================================================
say ""
say "[6/7] 建立管理員帳號"

EXISTING=$(psql_c "SELECT count(*) FROM public.members m JOIN auth.users u ON m.auth_id = u.id WHERE m.role = 'super_admin' AND m.is_active")
[ -z "$EXISTING" ] && EXISTING=0

if [ "$EXISTING" -gt 0 ]; then
  say "  （系統已有 $EXISTING 個管理員帳號；Email 留空直接按 Enter 可略過此步驟）"
fi

ADMIN_EMAIL=""
ADMIN_DONE=""
while [ -z "$ADMIN_DONE" ]; do
  printf "  管理員 Email："
  read -r ADMIN_EMAIL || { say ""; say "  （輸入已結束，略過建立管理員。之後可重新執行 sh install.sh 建立。）"; ADMIN_DONE=skip; break; }
  ADMIN_EMAIL=$(printf '%s' "$ADMIN_EMAIL" | tr -d '[:space:]')

  if [ -z "$ADMIN_EMAIL" ]; then
    if [ "$EXISTING" -gt 0 ]; then
      say "  已略過（沿用既有管理員帳號）。"
      ADMIN_DONE=skip
      continue
    fi
    printf "  尚未建立任何管理員，略過將無法登入系統。確定要略過嗎？[y/N] "
    read -r ANS || ANS=y
    case "$ANS" in
      y|Y) say "  已略過。之後可重新執行 sh install.sh 建立管理員。"; ADMIN_DONE=skip ;;
      *)   ;;
    esac
    continue
  fi

  case "$ADMIN_EMAIL" in
    *@*.*) ;;
    *) say "  Email 格式不正確，請重新輸入。"; continue ;;
  esac

  # ---- 密碼（輸入兩次）----
  PW1=""
  while [ -z "$PW1" ]; do
    printf "  密碼（至少 8 碼）："
    stty -echo 2>/dev/null
    read -r _pw1 || { ADMIN_DONE=skip; say ""; say "  （輸入已結束，略過建立管理員。）"; break 2; }
    stty echo 2>/dev/null
    printf "\n"
    if [ "${#_pw1}" -lt 8 ]; then
      say "  密碼太短（至少 8 碼），請重新輸入。"
      continue
    fi
    printf "  再輸入一次密碼："
    stty -echo 2>/dev/null
    read -r _pw2 || { ADMIN_DONE=skip; say ""; say "  （輸入已結束，略過建立管理員。）"; break 2; }
    stty echo 2>/dev/null
    printf "\n"
    if [ "$_pw1" != "$_pw2" ]; then
      say "  兩次輸入的密碼不一致，請重新輸入。"
      continue
    fi
    PW1=$_pw1
  done

  run_admin_sql() {
    # $1 = create | reset；結果放在 OUT / RC
    OUT=$({
      printf "SELECT set_config('livo.admin_email', '%s', false);\n" "$(esc_sql "$ADMIN_EMAIL")"
      printf "SELECT set_config('livo.admin_password', '%s', false);\n" "$(esc_sql "$PW1")"
      printf "SELECT set_config('livo.admin_mode', '%s', false);\n" "$1"
      cat "$ADMIN_SQL"
    } | dc exec -T db psql -U supabase_admin -h localhost -d postgres -q -v ON_ERROR_STOP=1 2>&1)
    RC=$?
  }

  run_admin_sql create
  if [ "$RC" -eq 0 ]; then
    say "  [OK] 管理員帳號已建立：$ADMIN_EMAIL"
    ADMIN_DONE=created
  else
    case "$OUT" in
      *LIVO_ERR_EMAIL_EXISTS*)
        printf "  此 Email 已有帳號。要把密碼重設為剛剛輸入的新密碼嗎？[y/N] "
        read -r ANS || ANS=n
        case "$ANS" in
          y|Y)
            run_admin_sql reset
            if [ "$RC" -eq 0 ]; then
              say "  [OK] 密碼已重設，並確認其為管理員：$ADMIN_EMAIL"
              ADMIN_DONE=reset
            else
              say "$OUT"
              die "密碼重設失敗。" "請截圖上方錯誤訊息並聯絡我們。"
            fi
            ;;
          *)
            say "  已取消，請改用其他 Email。"
            ;;
        esac
        ;;
      *)
        say "$OUT"
        die "管理員帳號建立失敗。" "請截圖上方錯誤訊息並聯絡我們。"
        ;;
    esac
  fi
done

# ============================================================
# [7/7] 完成
# ============================================================
say ""
say "[7/7] 檢查前端服務..."
if docker ps --filter "name=livo-frontend" --filter "status=running" -q 2>/dev/null | grep -q .; then
  say "  [OK] 前端服務執行中"
else
  say "  [!] 前端容器沒有在執行。查看原因：cd docker && docker compose -f docker-compose.yml -f compose.frontend.yml logs livo-frontend"
fi

say ""
say "=============================================================="
say "  LIVO 安裝完成！"
say "=============================================================="
say ""
say "  前端網址：   http://localhost:${FRONTEND_PORT}/demo/"
say "  登入頁：     http://localhost:${FRONTEND_PORT}/demo/auth"
if [ "$ADMIN_DONE" = "created" ] || [ "$ADMIN_DONE" = "reset" ]; then
  say "  管理員帳號： $ADMIN_EMAIL"
fi
say "  管理後台：   http://localhost:${KONG_PORT}（Supabase Studio，帳密見 docker/.env）"
if [ "$KONG_PORT" != "8000" ]; then
  say ""
  say "  （註：LIVO API 閘道使用連接埠 $KONG_PORT——8000 在這台機器上無法使用，"
  say "    已自動改用並同步更新前端；上面的使用網址不受影響。）"
fi
say ""
say "  下一步："
say "  1. 用管理員帳號登入前端"
say "  2. 到「系統管理」新增成員、建立第一個專案"
say ""
say "  常用指令（在 docker/ 目錄執行）："
say "  停止：docker compose -f docker-compose.yml -f compose.frontend.yml down"
say "  啟動：docker compose -f docker-compose.yml -f compose.frontend.yml up -d"
say "  記錄：docker compose logs -f"
say ""
say "  $SUPPORT"
say ""
exit 0
