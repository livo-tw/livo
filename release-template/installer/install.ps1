# ============================================================
#  LIVO 自架版 一鍵安裝（Windows）
#
#  請不要直接執行本檔，請改用套件根目錄的 install.bat
#  （它會用正確的參數啟動本安裝程式）。
#
#  本程式可重複執行：已完成的步驟會自動略過。
# ============================================================

$ErrorActionPreference = 'Continue'
# POSIX 權限修正僅用於 Linux/macOS；Windows Docker Desktop 的 bind mount 不使用 POSIX 模式，無需 chmod。

# ---------- 路徑與常數 ----------
$Root       = Split-Path -Parent $PSScriptRoot          # installer\ 的上一層 = 套件根目錄
$DockerDir  = Join-Path $Root 'docker'
$SchemaFile = Join-Path $Root 'schema\livo-schema.sql'
$FirstRun   = Join-Path $Root 'schema\first-run.sql'
$UpgradesDir = Join-Path $Root 'schema\upgrades'
$BackupDir  = Join-Path $Root 'backups'
$AdminSql   = Join-Path $PSScriptRoot 'create-admin.sql'
$KeygenJs   = Join-Path $PSScriptRoot 'generate-keys.js'
$EnvFile    = Join-Path $DockerDir '.env'
$KongYml    = Join-Path $DockerDir 'volumes\api\kong.yml'
$Support    = '遇到問題？請到 https://github.com/livo-tw/livo/issues 回報。'

# 前端 bundle 內嵌 anon key 的固定前綴（HS256 JWT header + {"role":"anon" 開頭
# 的 payload）。generate-keys.js 保證新 key 也有同樣前綴，因此重跑安裝時
# 一樣找得到、換得掉（自我修復，不依賴 .env 舊值）。
$AnonJwtRe  = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9\.eyJyb2xlIjoiYW5vbiI[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*'

$script:ComposeArgs = @(
  '-f', (Join-Path $DockerDir 'docker-compose.yml'),
  '-f', (Join-Path $DockerDir 'compose.frontend.yml'),
  '--project-directory', $DockerDir
)

function Say([string]$msg) { Write-Host $msg }
function Ok([string]$msg)  { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Warn([string]$msg){ Write-Host "  [!] $msg" -ForegroundColor Yellow }
function Hr() { Write-Host ('-' * 60) }

function Fail([string]$title, [string]$detail) {
  Hr
  Write-Host "[X] $title" -ForegroundColor Red
  if ($detail) { Write-Host $detail }
  Write-Host ''
  Write-Host $Support
  exit 1
}

function Invoke-Compose {
  & docker compose @script:ComposeArgs @args
}

# 單行 SQL 查詢（回傳結果字串；失敗回 $null）
function Invoke-PsqlQuery([string]$Sql) {
  $out = & docker compose @script:ComposeArgs exec -T db psql -U supabase_admin -h localhost -d postgres -tA -c $Sql 2>$null
  if ($LASTEXITCODE -ne 0) { return $null }
  return (($out | Out-String).Trim())
}

# 把 SQL bytes 灌進資料庫（ON_ERROR_STOP；避免任何編碼轉換）
function Invoke-PsqlBytes([byte[]]$SqlBytes) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'docker'
  $argList = @('compose') + $script:ComposeArgs +
             @('exec', '-T', 'db', 'psql', '-U', 'supabase_admin', '-h', 'localhost',
               '-d', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1')
  $quoted = $argList | ForEach-Object { if ($_ -match '[\s"]') { '"' + $_ + '"' } else { $_ } }
  $psi.Arguments = $quoted -join ' '
  $psi.UseShellExecute        = $false
  $psi.RedirectStandardInput  = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError  = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding  = [System.Text.Encoding]::UTF8
  $proc = [System.Diagnostics.Process]::Start($psi)
  $soTask = $proc.StandardOutput.ReadToEndAsync()
  $seTask = $proc.StandardError.ReadToEndAsync()
  $proc.StandardInput.BaseStream.Write($SqlBytes, 0, $SqlBytes.Length)
  $proc.StandardInput.BaseStream.Flush()
  $proc.StandardInput.Close()
  $proc.WaitForExit()
  return [pscustomobject]@{
    ExitCode = $proc.ExitCode
    Output   = ($soTask.Result + "`n" + $seTask.Result)
  }
}

function Invoke-PsqlFile([string]$Path) {
  return Invoke-PsqlBytes ([System.IO.File]::ReadAllBytes($Path))
}

function ConvertTo-SqlLiteral([string]$s) { return ($s -replace "'", "''") }

function ConvertFrom-SecureToPlain([securestring]$sec) {
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}

$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Set-DotenvVar([string]$Name, [string]$Value) {
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  $pattern = '(?m)^' + [regex]::Escape($Name) + '=[^\r\n]*'
  if ($raw -match $pattern) {
    $raw = [regex]::Replace($raw, $pattern, ($Name + '=' + $Value))
  } else {
    if ($raw -notmatch "(\r?\n)$") { $raw += "`r`n" }
    $raw += ($Name + '=' + $Value + "`r`n")
  }
  [System.IO.File]::WriteAllText($script:EnvFile, $raw, $script:Utf8NoBom)
}

function Get-DotenvValue([string]$Name) {
  if (-not (Test-Path $script:EnvFile)) { return $null }
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($raw -match ('(?m)^' + [regex]::Escape($Name) + '=([^\r\n]*)')) { return $Matches[1].Trim() }
  return $null
}

# ---------- docker\.env：這套安裝專屬的金鑰 ----------
# 安裝包只附出廠範本 docker\.env.factory，第一次安裝才複製成 docker\.env。
# 升級時把新版檔案整包蓋過來，也不會動到既有的 .env。
$FactoryEnvFile = Join-Path $DockerDir '.env.factory'

function Initialize-EnvFile {
  if (Test-Path $script:EnvFile) { return }
  if (Test-Path (Join-Path $DockerDir 'volumes\db\data')) {
    Fail '找不到 docker\.env，但這台機器已經有 LIVO 的資料庫。' ("docker\.env 存著這套安裝專屬的金鑰，不能用出廠值重建。`n" +
      '請把 backups\ 裡最新的 docker-env-*.bak 複製回 docker\.env，再重新執行 install.bat。')
  }
  if (-not (Test-Path $FactoryEnvFile)) {
    Fail '找不到 docker\.env.factory。' '套件不完整，請重新解壓縮。'
  }
  try { Copy-Item -Path $FactoryEnvFile -Destination $script:EnvFile -ErrorAction Stop }
  catch { Fail '無法建立 docker\.env。' '請確認目前的使用者可以寫入 docker\ 資料夾。' }
}

# 檔名是時間戳，依名稱排序 = 依時間排序
function Get-EnvBackups {
  if (-not (Test-Path $BackupDir)) { return @() }
  return @(Get-ChildItem -Path $BackupDir -Filter 'docker-env-*.bak' -File | Sort-Object Name)
}

# 已有專屬金鑰的 .env 每次執行都備份一份到 backups\（內容沒變就不重複備份）。
function Backup-EnvFile {
  if (-not (Test-Path $script:EnvFile)) { return }
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($raw -notmatch '(?m)^LIVO_KEYS_ROTATED=1') { return }
  $backups = @(Get-EnvBackups)
  if ($backups.Count -gt 0) {
    $latest = [System.IO.File]::ReadAllText($backups[-1].FullName)
    if ($latest -eq $raw) { return }
  }
  try {
    if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force -ErrorAction Stop | Out-Null }
    $bak = Join-Path $BackupDir ('docker-env-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.bak')
    Copy-Item -Path $script:EnvFile -Destination $bak -ErrorAction Stop
    Ok ('已備份 docker\.env → backups\' + (Split-Path -Leaf $bak))
  } catch {}
}

# 既有安裝的 .env 被出廠預設值蓋掉（例如升級時把舊版套件的 docker\.env 一起複製
# 進來）：繼續跑會用公開的出廠密碼啟動，服務連不上資料庫。先停下來。
function Assert-EnvNotOverwritten {
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($raw -match '(?m)^LIVO_KEYS_ROTATED=1') { return }
  if (-not (Test-Path (Join-Path $DockerDir 'volumes\db\data'))) { return }
  $rotated = @(Get-EnvBackups | Where-Object {
    [System.IO.File]::ReadAllText($_.FullName) -match '(?m)^LIVO_KEYS_ROTATED=1'
  })
  if ($rotated.Count -eq 0) { return }
  Fail 'docker\.env 被換成出廠預設值了，這套安裝原本的專屬金鑰不在裡面。' ("請把備份複製回去，再重新執行 install.bat：`n" +
    '  把 backups\' + $rotated[-1].Name + ' 複製成 docker\.env')
}

# 前端 bundle 的 .js 檔（app\demo\assets\*.js + app\*.js）
function Get-BundleJsFiles {
  $files = @()
  $assetsDir = Join-Path $Root 'app\demo\assets'
  if (Test-Path $assetsDir) { $files += @(Get-ChildItem -Path $assetsDir -Filter '*.js' -File) }
  $appDir = Join-Path $Root 'app'
  if (Test-Path $appDir) { $files += @(Get-ChildItem -Path $appDir -Filter '*.js' -File) }
  return $files
}

# 自訂前端 port（docker\.env 可設 LIVO_FRONTEND_PORT）
$FrontendPort = 3000
$m = Get-DotenvValue 'LIVO_FRONTEND_PORT'
if ($m -match '^\d+$') { $FrontendPort = [int]$m }

Say '=============================================================='
Say '  LIVO 自架版 一鍵安裝'
Say '=============================================================='

foreach ($req in @(
  @{ p = (Join-Path $DockerDir 'docker-compose.yml');   n = 'docker/docker-compose.yml' },
  @{ p = (Join-Path $DockerDir 'compose.frontend.yml'); n = 'docker/compose.frontend.yml' },
  @{ p = $SchemaFile;                                   n = 'schema/livo-schema.sql' },
  @{ p = $AdminSql;                                     n = 'installer/create-admin.sql' }
)) {
  if (-not (Test-Path $req.p)) {
    Fail ("找不到 " + $req.n + "。") "套件不完整。請把整個 zip 完整解壓縮後，再執行套件根目錄的 install.bat。"
  }
}

Initialize-EnvFile
Assert-EnvNotOverwritten
Backup-EnvFile
# 自架版不用公開註冊（第一個管理員由安裝程式建立，成員由團隊設定建立登入）。
# 舊版範本預設開放註冊，任何連得到伺服器的人都能自己建帳號；每次執行都關掉。
if ((Get-DotenvValue 'DISABLE_SIGNUP') -ne 'true') {
  Set-DotenvVar 'DISABLE_SIGNUP' 'true'
  Ok '已關閉公開註冊（DISABLE_SIGNUP=true）'
}

# ============================================================
# [1/7] 環境檢查
# ============================================================
Say ''
Say '[1/7] 檢查環境...'

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail '找不到 Docker。' @'
請先安裝 Docker Desktop（Windows）：
  https://www.docker.com/products/docker-desktop/
安裝時保持預設的 WSL2 後端即可。裝好並啟動 Docker Desktop 後，
再重新執行 install.bat。
'@
}

& docker info *> $null
if ($LASTEXITCODE -ne 0) {
  Fail 'Docker Desktop 尚未啟動。' @'
請從開始選單開啟 Docker Desktop，等待左下角顯示綠色（Engine running）後，
再重新執行 install.bat。
若 Docker Desktop 一直起不來，多半是 WSL2 未啟用：
以系統管理員開啟 PowerShell 執行  wsl --install  後重新開機。
'@
}

& docker compose version *> $null
if ($LASTEXITCODE -ne 0) {
  Fail '找不到 Docker Compose v2。' '請把 Docker Desktop 更新到最新版本（內建 Compose v2），再重新執行 install.bat。'
}
Ok 'Docker / Docker Compose v2'

# ---- 連接埠檢查（真實 bind 測試）----
# netstat / Get-NetTCPConnection 只能看到「有人在 LISTEN」的埠。Windows 的
# winnat/Hyper-V「保留埠段」不會 LISTEN、查不到，但 bind 一樣會失敗
#（docker compose up 直接死在 Ports are not available）。因此改用真實 bind
# 測試：TcpListener 對保留埠段的行為與 docker 發布埠一致（已實測——兩者在
# 保留埠上都回 access permissions 錯誤），而且不用等 docker。
# 查保留埠段：netsh interface ipv4 show excludedportrange protocol=tcp
$runningNames = @()
$psOut = & docker ps --format '{{.Names}}' 2>$null
if ($psOut) { $runningNames = @($psOut) }

function Test-PortBindable([int]$Port) {
  try {
    $l = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Any, $Port)
    $l.Start()
    $l.Stop()
    return $true
  } catch { return $false }
}

# --- Kong（API 閘道）HTTP 埠：預設 8000；無法使用時自動改用備選埠 ---
$KongPort = 8000
$m = Get-DotenvValue 'KONG_HTTP_PORT'
if ($m -match '^\d+$') { $KongPort = [int]$m }

if ($runningNames -contains 'supabase-kong') {
  # kong 已在執行（重跑安裝），這個埠必然可用
} elseif (-not (Test-PortBindable $KongPort)) {
  Warn "連接埠 $KongPort 無法使用（被其他程式占用，或落在 Windows 系統保留埠段）。"
  $picked = $null
  foreach ($cand in 18000, 28000, 38000, 48000) {
    if (Test-PortBindable $cand) { $picked = $cand; break }
  }
  if (-not $picked) {
    Fail '找不到可用的 API 閘道連接埠。' @'
8000 / 18000 / 28000 / 38000 / 48000 全部無法使用。
請關閉占用這些埠的程式後重新執行 install.bat。
（查 Windows 保留埠段：netsh interface ipv4 show excludedportrange protocol=tcp）
'@
  }
  Say "      已自動改用連接埠 $picked（前端會同步更新，使用網址不變）。"
  $KongPort = $picked
}

# 讓 docker\.env 與前端 bundle 都對齊選定的 kong 埠。
# 冪等：.env 的 LIVO_KONG_PORT_PATCHED 記錄「bundle 目前引用的埠」（出廠為
# 8000），重跑時從那個值換到新值，不會重複改壞。
function Update-KongPortBinding {
  $bundlePort = 8000
  $mp = Get-DotenvValue 'LIVO_KONG_PORT_PATCHED'
  if ($mp -match '^\d+$') { $bundlePort = [int]$mp }

  Set-DotenvVar 'KONG_HTTP_PORT' $script:KongPort
  # SUPABASE_PUBLIC_URL / API_EXTERNAL_URL 出廠指向 localhost:<kong 埠>；
  # 只在仍是 localhost 預設值時跟著改（不動客戶自訂的網域）
  foreach ($var in 'SUPABASE_PUBLIC_URL', 'API_EXTERNAL_URL') {
    $cur = Get-DotenvValue $var
    if ($cur -match '^http://localhost:\d+$') {
      Set-DotenvVar $var ('http://localhost:' + $script:KongPort)
    }
  }

  # 逐檔檢查：升級換上新版 app\ 後，新檔案又是出廠的 8000，舊檔可能還留著
  $newRef = 'localhost:' + $script:KongPort
  $oldRefs = @(@($bundlePort, 8000) | Select-Object -Unique | Where-Object { $_ -ne [int]$script:KongPort } |
               ForEach-Object { 'localhost:' + $_ })
  $patched = 0
  foreach ($f in (Get-BundleJsFiles)) {
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    $new = $txt
    foreach ($ref in $oldRefs) { $new = $new.Replace($ref, $newRef) }
    if ($new -cne $txt) {
      [System.IO.File]::WriteAllText($f.FullName, $new, $script:Utf8NoBom)
      $patched++
    }
  }
  if ($patched -gt 0) {
    Ok "API 閘道改用連接埠 $($script:KongPort)（前端已同步更新 $patched 個檔案）"
  }
  Set-DotenvVar 'LIVO_KONG_PORT_PATCHED' $script:KongPort
}
Update-KongPortBinding

# --- 前端埠 / HTTPS 埠：真實 bind 測試 + 原本的改埠指引 ---
$portFail = $false
if (-not ($runningNames -contains 'livo-frontend') -and -not (Test-PortBindable $FrontendPort)) {
  Warn "連接埠 $FrontendPort 無法使用（LIVO 前端；被占用或被系統保留）。"
  Say  '      可改用其他埠：在 docker\.env 加一行 LIVO_FRONTEND_PORT=3001，再重新執行安裝。'
  $portFail = $true
}

# （kong HTTPS 埠與資料庫連線池都不再對外發布——8443 上本來就沒設 TLS 憑證、
#   沒有任何服務；DB 走 docker exec / 容器內網。少開埠 = 少一種裝不起來的方式。）

if ($portFail) {
  Fail '有連接埠無法使用，無法啟動。' @'
請依上方指示處理後，重新執行 install.bat。
（占用查詢：netstat -ano | findstr :3000；Windows 保留埠段：
  netsh interface ipv4 show excludedportrange protocol=tcp）
'@
}
Ok "連接埠檢查通過（API 閘道：$KongPort）"

# ============================================================
# [2/7] 產生本安裝專屬金鑰
# ============================================================
# 出廠 zip 內的 docker\.env 只是預設值：每一套安裝都會在這裡換成
# 自己專屬的 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY / 資料庫密碼 /
# 後台密碼，並同步改寫前端 bundle 內嵌的 anon key。
# 冪等：.env 內出現 LIVO_KEYS_ROTATED=1 即略過（重跑不會作廢現有安裝）。

function Invoke-KeyRotation {
  $envRaw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($envRaw -match '(?m)^LIVO_KEYS_ROTATED=1') {
    Ok '本安裝已有專屬金鑰（先前產生過，略過）'
    return
  }
  if (Test-Path (Join-Path $DockerDir 'volumes\db\data')) {
    Warn '偵測到既有資料庫、但尚未產生專屬金鑰（可能是舊版安裝）。'
    Say  '      為避免破壞現有安裝，略過金鑰更換；建議聯絡我們協助升級金鑰。'
    return
  }
  if (-not (Test-Path $KeygenJs)) {
    Fail '找不到 installer/generate-keys.js。' '套件不完整，請重新解壓縮。'
  }

  Say '  產生本安裝專屬金鑰（第一次需下載小型工具映像檔）...'
  $jsonOut = (Get-Content -Raw $KeygenJs | & docker run --rm -i node:20-alpine node -)
  if ($LASTEXITCODE -ne 0 -or -not $jsonOut) {
    Fail '金鑰產生失敗（docker run node:20-alpine）。' '請確認這台機器可以連外網下載映像檔後，重新執行 install.bat。'
  }
  $keys = $null
  try { $keys = (($jsonOut | Out-String).Trim()) | ConvertFrom-Json } catch {}
  # 各服務內部加密金鑰（出廠值是公開的，一定要換；storage S3 金鑰見 Invoke-S3KeyRotation）
  $internalKeys = @('SECRET_KEY_BASE','VAULT_ENC_KEY','PG_META_CRYPTO_KEY','LOGFLARE_PUBLIC_ACCESS_TOKEN',
                    'LOGFLARE_PRIVATE_ACCESS_TOKEN')
  foreach ($k in @('JWT_SECRET','ANON_KEY','SERVICE_ROLE_KEY','POSTGRES_PASSWORD','DASHBOARD_PASSWORD') + $internalKeys) {
    if ($null -eq $keys -or -not $keys.$k) {
      Fail '金鑰產生結果不完整。' '請重新執行 install.bat；若持續失敗請聯絡我們。'
    }
  }

  # 記下 .env 目前的（舊）金鑰，稍後用來清掉任何殘留引用
  $oldEnvAnon = $null; $oldEnvService = $null
  if ($envRaw -match '(?m)^ANON_KEY=([^\r\n]+)')         { $oldEnvAnon = $Matches[1].Trim() }
  if ($envRaw -match '(?m)^SERVICE_ROLE_KEY=([^\r\n]+)') { $oldEnvService = $Matches[1].Trim() }

  # 1) 改寫 docker\.env
  Set-DotenvVar 'JWT_SECRET'        $keys.JWT_SECRET
  Set-DotenvVar 'ANON_KEY'          $keys.ANON_KEY
  Set-DotenvVar 'SERVICE_ROLE_KEY'  $keys.SERVICE_ROLE_KEY
  Set-DotenvVar 'POSTGRES_PASSWORD' $keys.POSTGRES_PASSWORD
  Set-DotenvVar 'DASHBOARD_PASSWORD' $keys.DASHBOARD_PASSWORD
  foreach ($k in $internalKeys) { Set-DotenvVar $k ([string]$keys.$k) }

  # 2) 改寫前端 bundle 內嵌的 anon key（從 bundle 本身找出目前的 key）
  $jsFiles = Get-BundleJsFiles

  $embeddedAnon = $null
  foreach ($f in $jsFiles) {
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    $m = [regex]::Match($txt, $AnonJwtRe)
    if ($m.Success) { $embeddedAnon = $m.Value; break }
  }
  if (-not $embeddedAnon) {
    Fail '在前端檔案中找不到內嵌的 API 金鑰。' '套件可能不完整，請重新解壓縮後再執行 install.bat。'
  }
  $patched = 0
  foreach ($f in $jsFiles) {
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    if ($txt.Contains($embeddedAnon)) {
      [System.IO.File]::WriteAllText($f.FullName, $txt.Replace($embeddedAnon, [string]$keys.ANON_KEY), $script:Utf8NoBom)
      $patched++
    }
  }

  # 3) 保險：kong.yml 正常只引用環境變數；若有人把金鑰寫死進去，一併更換
  if (Test-Path $KongYml) {
    $ky = [System.IO.File]::ReadAllText($KongYml)
    $kyOrig = $ky
    if ($embeddedAnon)  { $ky = $ky.Replace($embeddedAnon, [string]$keys.ANON_KEY) }
    if ($oldEnvAnon)    { $ky = $ky.Replace($oldEnvAnon, [string]$keys.ANON_KEY) }
    if ($oldEnvService) { $ky = $ky.Replace($oldEnvService, [string]$keys.SERVICE_ROLE_KEY) }
    if ($ky -cne $kyOrig) { [System.IO.File]::WriteAllText($KongYml, $ky, $script:Utf8NoBom) }
  }

  # 4) 寫入完成標記（重跑安裝不會再換金鑰）
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($raw -notmatch '(?m)^LIVO_KEYS_ROTATED=') {
    if ($raw -notmatch "(\r?\n)$") { $raw += "`r`n" }
    $raw += "`r`n# 安裝程式已產生本機專屬金鑰（請勿手動更改 JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY）`r`nLIVO_KEYS_ROTATED=1`r`n"
    [System.IO.File]::WriteAllText($script:EnvFile, $raw, $script:Utf8NoBom)
  }

  Ok ("已產生本安裝專屬金鑰（前端已同步更新 " + $patched + " 個檔案）")
}

# 檔案儲存（storage）的 S3 金鑰。舊版安裝程式沒有換它，出廠值又是公開的上游
# 預設值：連得到 API 閘道的人就能用它讀寫所有上傳檔。storage 只從環境變數讀
# 這組金鑰、不留衍生資料，所以已經在用的安裝也能安全更換（下一步 up -d 會帶
# 新值重建 storage 容器）。和 Invoke-KeyRotation 分開標記：舊版安裝重跑也會補換。
# 冪等：.env 內出現 LIVO_S3_KEYS_ROTATED=1 即略過。
function Invoke-S3KeyRotation {
  $envRaw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($envRaw -match '(?m)^LIVO_S3_KEYS_ROTATED=1') { return }
  if (-not (Test-Path $KeygenJs)) {
    Fail '找不到 installer/generate-keys.js。' '套件不完整，請重新解壓縮。'
  }
  $jsonOut = (Get-Content -Raw $KeygenJs | & docker run --rm -i node:20-alpine node -)
  $s3 = $null
  if ($LASTEXITCODE -eq 0 -and $jsonOut) {
    try { $s3 = (($jsonOut | Out-String).Trim()) | ConvertFrom-Json } catch {}
  }
  if ($null -eq $s3 -or -not $s3.S3_PROTOCOL_ACCESS_KEY_ID -or -not $s3.S3_PROTOCOL_ACCESS_KEY_SECRET) {
    Fail '檔案儲存金鑰產生失敗（docker run node:20-alpine）。' '請確認這台機器可以連外網下載映像檔後，重新執行 install.bat。'
  }
  Set-DotenvVar 'S3_PROTOCOL_ACCESS_KEY_ID'     ([string]$s3.S3_PROTOCOL_ACCESS_KEY_ID)
  Set-DotenvVar 'S3_PROTOCOL_ACCESS_KEY_SECRET' ([string]$s3.S3_PROTOCOL_ACCESS_KEY_SECRET)
  $raw = [System.IO.File]::ReadAllText($script:EnvFile)
  if ($raw -notmatch "(\r?\n)$") { $raw += "`r`n" }
  $raw += "LIVO_S3_KEYS_ROTATED=1`r`n"
  [System.IO.File]::WriteAllText($script:EnvFile, $raw, $script:Utf8NoBom)
  Ok '已產生本安裝專屬的檔案儲存 S3 金鑰'
}

# 前端 bundle 內嵌的 anon key 一律對齊 docker\.env。升級時換上新版 app\ 後，
# 新檔案又是出廠值（舊檔可能還留著），不同步就登入不了。逐檔檢查；冪等：
# 全部一致就什麼都不做。
function Sync-FrontendAnonKey {
  $cur = Get-DotenvValue 'ANON_KEY'
  if (-not $cur) { return }
  $replacement = $cur.Replace('$', '$$')
  $patched = 0
  foreach ($f in (Get-BundleJsFiles)) {
    $txt = [System.IO.File]::ReadAllText($f.FullName)
    $new = [regex]::Replace($txt, $AnonJwtRe, $replacement)
    if ($new -cne $txt) {
      [System.IO.File]::WriteAllText($f.FullName, $new, $script:Utf8NoBom)
      $patched++
    }
  }
  if ($patched -gt 0) {
    Ok ("前端檔案已換成本安裝的金鑰（" + $patched + " 個檔案；升級換上新版前端後的自動同步）")
  }
}

Say ''
Say '[2/7] 產生本安裝專屬金鑰...'
function Ensure-SlackSecret {
  if (Get-DotenvValue 'SLACK_INTERNAL_SECRET') { return }
  $slackBytes = New-Object byte[] 32
  $slackRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $slackRng.GetBytes($slackBytes) } finally { $slackRng.Dispose() }
  $slackSecret = -join ($slackBytes | ForEach-Object { $_.ToString('x2') })
  Set-DotenvVar 'SLACK_INTERNAL_SECRET' $slackSecret
}
function Ensure-KnowledgeSecrets {
  foreach ($knowledgeKey in @('KNOWLEDGE_PROCESSOR_TOKEN', 'KNOWLEDGE_IMPORT_SECRET')) {
    if (Get-DotenvValue $knowledgeKey) { continue }
    $knowledgeBytes = New-Object byte[] 32
    $knowledgeRng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $knowledgeRng.GetBytes($knowledgeBytes) } finally { $knowledgeRng.Dispose() }
    $knowledgeSecret = -join ($knowledgeBytes | ForEach-Object { $_.ToString('x2') })
    Set-DotenvVar $knowledgeKey $knowledgeSecret
  }
}

# 知識庫文件匯入處理器（PDF / Word / Markdown 解析、OCR）是選用服務，預設關閉：
# 它在這台機器上建置映像檔（需要連外下載 Debian 套件與 PyPI），並佔用約 1 GB 記憶體。
# docker\.env 設 KNOWLEDGE_PROCESSOR_ENABLED=1 再重跑安裝程式才會建置、啟動。
$script:KnowledgeProcessorUrl = 'http://knowledge-processor:8091'
function Test-KnowledgeProcessorEnabled {
  return @('1', 'true', 'yes', 'on') -contains ([string](Get-DotenvValue 'KNOWLEDGE_PROCESSOR_ENABLED')).ToLowerInvariant()
}
# 只清掉安裝程式自己填的內部網址；指向其他主機的自訂網址保留。
function Clear-KnowledgeProcessorUrl {
  if ((Get-DotenvValue 'KNOWLEDGE_PROCESSOR_URL') -eq $script:KnowledgeProcessorUrl) { Set-DotenvVar 'KNOWLEDGE_PROCESSOR_URL' '' }
}

Invoke-KeyRotation
Invoke-S3KeyRotation
Ensure-SlackSecret
Ensure-KnowledgeSecrets
if (Test-KnowledgeProcessorEnabled) {
  if (-not (Get-DotenvValue 'KNOWLEDGE_PROCESSOR_URL')) { Set-DotenvVar 'KNOWLEDGE_PROCESSOR_URL' $script:KnowledgeProcessorUrl }
} else {
  Clear-KnowledgeProcessorUrl
}
Sync-FrontendAnonKey
Backup-EnvFile

# ============================================================
# [3/7] 啟動服務
# ============================================================
Say ''
Say '[3/7] 啟動後端與前端服務（第一次執行需下載映像檔，約 5-10 分鐘）...'
# 選用的知識庫處理器：建置失敗只警告、不中止安裝（前端與資料庫更新照常進行），
# 文件匯入畫面會顯示「尚未設定私有文件處理服務」。服務放在 compose profile
# knowledge-processor 裡，只有啟用時才帶 COMPOSE_PROFILES 啟動。
function Remove-KnowledgeProcessor { # 停掉先前留下的處理器容器，釋放記憶體
  $previousProfiles = $env:COMPOSE_PROFILES
  $env:COMPOSE_PROFILES = 'knowledge-processor'
  try { Invoke-Compose rm -s -f knowledge-processor *> $null } finally { $env:COMPOSE_PROFILES = $previousProfiles }
}
if (Test-KnowledgeProcessorEnabled) {
  Say '  建置知識庫文件匯入處理器（選用，KNOWLEDGE_PROCESSOR_ENABLED=1）...'
  $env:COMPOSE_PROFILES = 'knowledge-processor'
  Invoke-Compose build knowledge-processor
  if ($LASTEXITCODE -eq 0) {
    Ok '知識庫文件匯入處理器已建置'
  } else {
    Remove-Item Env:COMPOSE_PROFILES -ErrorAction SilentlyContinue
    Clear-KnowledgeProcessorUrl
    Remove-KnowledgeProcessor
    Warn '知識庫文件匯入處理器建置失敗（多半是無法連外下載 Debian 套件或 PyPI），先略過，其他服務照常安裝。'
    Say '      文件匯入會顯示「尚未設定私有文件處理服務」；排除網路問題後重新執行 install.bat 即可。'
  }
} else {
  Remove-KnowledgeProcessor
  Say '  [i] 知識庫文件匯入處理器未啟用（選用，預設關閉；啟用方式見 README）'
}
Invoke-Compose up -d
if ($LASTEXITCODE -ne 0) {
  Fail 'docker compose 啟動失敗。' @'
常見原因：
  1. 網路無法下載映像檔：請確認這台機器可以連外網
  2. 磁碟空間不足：docker system df 檢查，docker system prune 清理
  3. 連接埠衝突：看上方錯誤訊息中的 port 編號
詳細記錄（在 docker\ 目錄執行）：
  docker compose -f docker-compose.yml -f compose.frontend.yml logs --tail=50
排除後重新執行 install.bat。
'@
}
# 重跑（例如升級換上新版檔案）時：API 閘道與後端函式只在啟動時讀設定檔
# （kong.yml、functions\），重新啟動才會載入新版。
if ($runningNames -contains 'supabase-kong') {
  Say '  重新載入 API 閘道與後端函式（載入新版設定）...'
  Invoke-Compose restart kong functions *> $null
  if ($LASTEXITCODE -ne 0) {
    Warn '重新載入失敗，可稍後在 docker\ 目錄執行：docker compose restart kong functions'
  }
}
# 前端與 Slack 連線容器直接掛載 app\。升級時 app\ 整個換新，但 compose 認為容器
# 定義沒變、不會重建，容器就一直指著已刪除的舊目錄（整站 404）。每次都強制重建。
Invoke-Compose up -d --force-recreate --no-deps livo-frontend livo-slack-socket *> $null
if ($LASTEXITCODE -ne 0) {
  Warn '前端重新啟動失敗，可稍後在 docker\ 目錄執行：docker compose -f docker-compose.yml -f compose.frontend.yml up -d --force-recreate livo-frontend'
}
Ok '服務已啟動'

# ============================================================
# [4/7] 等待資料庫就緒
# ============================================================
function Wait-Database {
  Write-Host '[4/7] 等待資料庫就緒（最多 3 分鐘）' -NoNewline
  for ($i = 0; $i -lt 90; $i++) {
    & docker compose @script:ComposeArgs exec -T db pg_isready -U postgres -h localhost *> $null
    if ($LASTEXITCODE -eq 0) {
      Say ''
      Ok '資料庫已就緒'
      return
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds 2
  }
  Say ''
  Say '  資料庫在 180 秒內沒有就緒。最近 30 行資料庫記錄：'
  Hr
  Invoke-Compose logs --tail=30 db
  Hr
  Fail '資料庫啟動逾時。' @'
常見原因與解法：
  1. 記憶體不足：Docker 至少需要 4GB RAM
     （Docker Desktop → Settings → Resources 調高記憶體）
  2. 磁碟已滿：檢查 C 槽剩餘空間，docker system prune 清理
  3. 連接埠衝突：上方記錄若出現 address already in use，請處理該埠
排除後重新執行 install.bat 即可（安裝程式可重複執行）。
'@
}

function Wait-BackendReady {
  Write-Host '      等待後端服務初始化（auth / storage / realtime）' -NoNewline
  $sql = "SELECT (to_regclass('auth.users') IS NOT NULL) AND (to_regclass('storage.buckets') IS NOT NULL) AND (EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime'))"
  for ($i = 0; $i -lt 90; $i++) {
    if ((Invoke-PsqlQuery $sql) -eq 't') {
      Say ''
      Ok '後端服務初始化完成'
      return
    }
    Write-Host '.' -NoNewline
    Start-Sleep -Seconds 2
  }
  Say ''
  Say '  以下服務尚未完成初始化：'
  if ((Invoke-PsqlQuery "SELECT to_regclass('auth.users') IS NOT NULL") -ne 't')      { Say '    - auth（帳號系統）    記錄：docker compose logs --tail=20 auth' }
  if ((Invoke-PsqlQuery "SELECT to_regclass('storage.buckets') IS NOT NULL") -ne 't') { Say '    - storage（檔案系統）  記錄：docker compose logs --tail=20 storage' }
  if ((Invoke-PsqlQuery "SELECT EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')") -ne 't') { Say '    - realtime（協作同步） 記錄：docker compose logs --tail=20 realtime' }
  Fail '後端服務初始化逾時。' @'
請到 docker\ 目錄執行上列 logs 指令查看原因（多半是記憶體不足），
排除後重新執行 install.bat。
'@
}

Wait-Database
Wait-BackendReady

# ============================================================
# [5/7] 建立資料庫結構
# ============================================================
Say ''
Say '[5/7] 建立資料庫結構...'

function Write-InstallMarker {
  $null = Invoke-PsqlQuery "CREATE TABLE IF NOT EXISTS public.livo_install_state (key text PRIMARY KEY, value text, updated_at timestamptz NOT NULL DEFAULT now())"
  $null = Invoke-PsqlQuery "ALTER TABLE public.livo_install_state ENABLE ROW LEVEL SECURITY"
  $null = Invoke-PsqlQuery "INSERT INTO public.livo_install_state (key, value) VALUES ('schema_applied','1') ON CONFLICT (key) DO UPDATE SET value='1', updated_at=now()"
}

function Install-Schema {
  Say '  套用資料庫結構（約 1 分鐘）...'
  $res = Invoke-PsqlFile $SchemaFile
  if ($res.ExitCode -ne 0) {
    Say $res.Output
    Fail '資料庫結構建立失敗。' @'
請截圖上方錯誤訊息。你可以：
  1. 重新執行 install.bat，選擇「重置資料庫」再試一次
  2. 或聯絡我們協助處理
'@
  }
  Write-InstallMarker
  $script:SchemaJustApplied = $true
  Ok '資料庫結構建立完成'
}

function Reset-Database {
  Say '  正在重置資料庫（停止服務、刪除資料、重新啟動）...'
  Invoke-Compose down -v *> $null
  $dataDir = Join-Path $DockerDir 'volumes\db\data'
  if (Test-Path $dataDir) {
    try { Remove-Item -Recurse -Force $dataDir -ErrorAction Stop }
    catch { Fail '無法刪除資料庫資料目錄。' ("請手動刪除以下資料夾後重新執行 install.bat：`n  " + $dataDir) }
  }
  # 資料已清空：若這套安裝還沒有專屬金鑰（舊版安裝升級），現在補產生
  Invoke-KeyRotation
  Invoke-Compose up -d
  if ($LASTEXITCODE -ne 0) { Fail '重置後重新啟動失敗。' '請重新執行 install.bat。' }
  Wait-Database
  Wait-BackendReady
}

# 狀態偵測分兩步：不能在同一句 SQL 裡 SELECT 一張「可能不存在」的表——
# PostgreSQL 在解析期就會報 relation does not exist（CASE 只短路執行、
# 不短路解析），全新資料庫會整句失敗。先查表存在與否，存在才查內容。
$tbls = Invoke-PsqlQuery ("SELECT (to_regclass('public.livo_install_state') IS NOT NULL)::text" +
  " || ',' || (to_regclass('public.standup_sessions') IS NOT NULL)::text" +
  " || ',' || (to_regclass('public.members') IS NOT NULL)::text")
$state = $null
if ($tbls -match '^true,') {
  $mark = Invoke-PsqlQuery "SELECT EXISTS (SELECT 1 FROM public.livo_install_state WHERE key='schema_applied')::text"
  if ($mark -eq 'true') { $state = 'applied' } else { $state = 'partial' }
} elseif ($tbls -eq 'false,true,true') { $state = 'legacy' }
elseif ($tbls -match '^false,(true|false),true$') { $state = 'partial' }
elseif ($tbls -match '^false,(true|false),false$') { $state = 'fresh' }

switch ($state) {
  'applied' {
    Say '  資料庫已初始化，略過建立（接著檢查資料庫更新）。'
  }
  'legacy' {
    Say '  偵測到既有的 LIVO 資料庫（先前手動安裝完成），略過建立。'
    Write-InstallMarker
  }
  'partial' {
    Warn '資料庫結構不完整（可能上次安裝中斷）。'
    $ans = Read-Host '  要重置資料庫重新安裝嗎？資料庫內所有資料將被刪除！[y/N]'
    if ($ans -match '^(y|Y|yes|YES)$') {
      Reset-Database
      Install-Schema
    } else {
      Fail '已取消安裝。' '若這個資料庫裡有重要資料，請不要重置，聯絡我們協助處理。'
    }
  }
  'fresh' {
    Install-Schema
  }
  default {
    Fail '無法確認資料庫狀態（連線失敗）。' @'
請稍等 1 分鐘後重新執行 install.bat。
若持續失敗，到 docker\ 目錄執行：docker compose logs --tail=30 db
'@
  }
}

# ---- 資料庫更新（既有安裝：套用新版新增的資料表 / 欄位）----
# schema\upgrades\ 每個檔案是一個 migration、一個交易；套用成功就記在
# public.livo_schema_migrations，所以每個更新只會套用一次，可安全重跑。
# 全新安裝的 livo-schema.sql 已記錄它包含的 migration，這裡不會重複套用。
# 這些更新都是冪等、不刪資料的（打包時 scripts/release-upgrades.mjs 檢查過）。
function Backup-Database {
  # 成功回傳備份檔路徑，失敗回傳 $null
  if (-not (Test-Path $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }
  $file = Join-Path $BackupDir ('livo-db-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.dump')
  Invoke-Compose exec -T db pg_dump -U supabase_admin -h localhost -d postgres -Fc -f /tmp/livo-backup.dump | Out-Host
  if ($LASTEXITCODE -ne 0) { return $null }
  & docker cp 'supabase-db:/tmp/livo-backup.dump' $file *> $null
  $copied = ($LASTEXITCODE -eq 0)
  Invoke-Compose exec -T db rm -f /tmp/livo-backup.dump *> $null
  if (-not $copied -or -not (Test-Path $file) -or (Get-Item $file).Length -eq 0) { return $null }
  return $file
}

function Install-Upgrades {
  if (-not (Test-Path $UpgradesDir)) { return }
  [string[]]$names = @(Get-ChildItem -Path $UpgradesDir -File | Where-Object { $_.Name -like '*.sql' } | ForEach-Object { $_.Name })
  if ($names.Count -eq 0) { return }
  [Array]::Sort($names, [System.StringComparer]::Ordinal)   # 檔名順序 = migration 順序
  $applied = @()
  if ((Invoke-PsqlQuery "SELECT to_regclass('public.livo_schema_migrations') IS NOT NULL") -eq 't') {
    $out = Invoke-PsqlQuery 'SELECT name FROM public.livo_schema_migrations'
    if ($out) { $applied = @($out -split "\r?\n" | ForEach-Object { $_.Trim() }) }
  }
  $pending = @($names | Where-Object { $applied -cnotcontains $_ })
  if ($pending.Count -eq 0) {
    if (-not $script:SchemaJustApplied) { Ok '資料庫結構已是最新版本' }
    return
  }

  Say ''
  Say ('  有 ' + $pending.Count + ' 個資料庫更新還沒套用（新版新增的資料表 / 欄位）：')
  foreach ($n in $pending) { Say ('    - ' + $n) }
  Say '  更新只會新增或調整結構，不會刪除任何資料；套用前會先把整個資料庫備份到 backups\。'
  $ans = Read-Host '  要現在備份並套用嗎？[Y/n]'
  if ($ans -match '^(n|N|no|NO)$') {
    Say '  已略過。之後重新執行 install.bat 即可套用（套用前新版功能可能無法使用）。'
    return
  }

  Say '  備份資料庫...'
  $backup = Backup-Database
  if ($backup) {
    Ok ('已備份：backups\' + (Split-Path -Leaf $backup))
  } else {
    Warn '資料庫備份失敗（請看上方訊息）。'
    $ans = Read-Host '  不備份、直接套用更新嗎？建議先排除問題再重跑。[y/N]'
    if ($ans -notmatch '^(y|Y|yes|YES)$') {
      Say '  已略過資料庫更新。排除問題後重新執行 install.bat 即可。'
      return
    }
  }

  foreach ($n in $pending) {
    Write-Host ('  套用 ' + $n + ' ...') -NoNewline
    $res = Invoke-PsqlFile (Join-Path $UpgradesDir $n)
    if ($res.ExitCode -eq 0) {
      Say ' OK'
    } else {
      Say ''
      Say $res.Output
      $where = if ($backup) { $backup } else { '（這次沒有備份）' }
      Fail ('資料庫更新 ' + $n + ' 套用失敗。') ("這個更新沒有完成，它在交易內的變更已自動復原；先前的更新與所有資料都不受影響。`n備份檔：" + $where + "`n請截圖上方錯誤訊息。排除後重新執行 install.bat，會從這個更新繼續。")
    }
  }
  # 讓 PostgREST 立刻看到新的資料表（不必等它自己重新載入）
  $null = Invoke-PsqlQuery "NOTIFY pgrst, 'reload schema'"
  Ok ('資料庫更新完成（' + $pending.Count + ' 個）')
}
Install-Upgrades

# ---- first-run.sql（預設狀態、移除示範資料；冪等）----
if (Test-Path $FirstRun) {
  Say '  套用初始化設定（first-run.sql）...'
  $res = Invoke-PsqlFile $FirstRun
  if ($res.ExitCode -eq 0) {
    Ok '初始化設定完成'
  } else {
    Say $res.Output
    Warn 'first-run.sql 執行有誤（不影響主要功能）。請截圖上方訊息並聯絡我們。'
  }
}

# ---- 授權重置碼（每套安裝唯一；已設定過則沿用既有的）----
# reset_license() 會比對 system_settings key='license_reset_code'。
# ON CONFLICT DO NOTHING → 重跑安裝不會改掉已存在的重置碼。
$script:ResetCode = ''
function Set-LicenseResetCode {
  $chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  $bytes = New-Object byte[] 8
  $rng = New-Object System.Security.Cryptography.RNGCryptoServiceProvider
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $suffix = -join ($bytes | ForEach-Object { $chars[[int]$_ % $chars.Length] })
  $candidate = "LIVO-RESET-$suffix"
  $null = Invoke-PsqlQuery ("INSERT INTO public.system_settings (key, value) VALUES ('license_reset_code', to_jsonb('" + $candidate + "'::text)) ON CONFLICT (key) DO NOTHING")
  $stored = Invoke-PsqlQuery "SELECT value #>> '{}' FROM public.system_settings WHERE key = 'license_reset_code'"
  if ($stored) {
    $script:ResetCode = $stored
    Ok '授權重置碼已設定'
  } else {
    Warn '無法設定授權重置碼（不影響主要功能）。請截圖上方訊息並聯絡我們。'
  }
}

# ============================================================
# [6/7] 建立管理員帳號
# ============================================================
Say ''
Say '[6/7] 建立管理員帳號'

$existing = Invoke-PsqlQuery "SELECT count(*) FROM public.members m JOIN auth.users u ON m.auth_id = u.id WHERE m.role = 'super_admin' AND m.is_active"
if (-not $existing) { $existing = '0' }
$existingCount = [int]$existing

if ($existingCount -gt 0) {
  Say "  （系統已有 $existingCount 個管理員帳號；Email 留空直接按 Enter 可略過此步驟）"
}

function Invoke-AdminSql([string]$Email, [string]$Password, [string]$Mode) {
  $prelude = "SELECT set_config('livo.admin_email', '$(ConvertTo-SqlLiteral $Email)', false);`n" +
             "SELECT set_config('livo.admin_password', '$(ConvertTo-SqlLiteral $Password)', false);`n" +
             "SELECT set_config('livo.admin_mode', '$Mode', false);`n"
  [byte[]]$bytes = [System.Text.Encoding]::UTF8.GetBytes($prelude) + [System.IO.File]::ReadAllBytes($AdminSql)
  return Invoke-PsqlBytes $bytes
}

$adminEmail = ''
$adminDone  = ''
while (-not $adminDone) {
  $adminEmail = (Read-Host '  管理員 Email')
  $adminEmail = ($adminEmail -replace '\s', '')

  if (-not $adminEmail) {
    if ($existingCount -gt 0) {
      Say '  已略過（沿用既有管理員帳號）。'
      $adminDone = 'skip'
      continue
    }
    $ans = Read-Host '  尚未建立任何管理員，略過將無法登入系統。確定要略過嗎？[y/N]'
    if ($ans -match '^(y|Y)$') {
      Say '  已略過。之後可重新執行 install.bat 建立管理員。'
      $adminDone = 'skip'
    }
    continue
  }

  if ($adminEmail -notmatch '^[^@]+@[^@]+\.[^@]+$') {
    Say '  Email 格式不正確，請重新輸入。'
    continue
  }

  # ---- 密碼（輸入兩次，隱藏輸入）----
  $pw = $null
  while ($null -eq $pw) {
    $sec1 = Read-Host '  密碼（至少 8 碼）' -AsSecureString
    $pw1  = ConvertFrom-SecureToPlain $sec1
    if ($pw1.Length -lt 8) {
      Say '  密碼太短（至少 8 碼），請重新輸入。'
      continue
    }
    $sec2 = Read-Host '  再輸入一次密碼' -AsSecureString
    $pw2  = ConvertFrom-SecureToPlain $sec2
    if ($pw1 -cne $pw2) {
      Say '  兩次輸入的密碼不一致，請重新輸入。'
      continue
    }
    $pw = $pw1
  }

  $res = Invoke-AdminSql $adminEmail $pw 'create'
  if ($res.ExitCode -eq 0) {
    Ok "管理員帳號已建立：$adminEmail"
    $adminDone = 'created'
  }
  elseif ($res.Output -match 'LIVO_ERR_EMAIL_EXISTS') {
    $ans = Read-Host '  此 Email 已有帳號。要把密碼重設為剛剛輸入的新密碼嗎？[y/N]'
    if ($ans -match '^(y|Y)$') {
      $res2 = Invoke-AdminSql $adminEmail $pw 'reset'
      if ($res2.ExitCode -eq 0) {
        Ok "密碼已重設，並確認其為管理員：$adminEmail"
        $adminDone = 'reset'
      } else {
        Say $res2.Output
        Fail '密碼重設失敗。' '請截圖上方錯誤訊息並聯絡我們。'
      }
    } else {
      Say '  已取消，請改用其他 Email。'
    }
  }
  else {
    Say $res.Output
    Fail '管理員帳號建立失敗。' '請截圖上方錯誤訊息並聯絡我們。'
  }
}

# ============================================================
# [7/7] 完成
# ============================================================
Say ''
Say '[7/7] 檢查前端服務...'
# 等容器的健康檢查實際打到首頁成功（healthy），不只是「在執行」：
# 容器可能在執行，卻因為掛載失效而整站 404。
$frontendHealth = ''
for ($i = 0; $i -lt 75; $i++) {
  $frontendHealth = (& docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' livo-frontend 2>$null | Out-String).Trim()
  if ($frontendHealth -eq 'healthy') { break }
  Start-Sleep -Seconds 2
}
if ($frontendHealth -eq 'healthy') {
  Ok '前端服務正常（首頁可以開啟）'
} else {
  if (-not $frontendHealth) { $frontendHealth = '找不到容器' }
  Warn ('前端服務沒有正常回應（狀態：' + $frontendHealth + '）。先試著重新建立（在 docker\ 目錄執行）：docker compose -f docker-compose.yml -f compose.frontend.yml up -d --force-recreate livo-frontend')
  Warn '仍不行再看原因（在 docker\ 目錄執行）：docker compose -f docker-compose.yml -f compose.frontend.yml logs livo-frontend'
}

Say ''
Say '=============================================================='
Say '  LIVO 安裝完成！'
Say '=============================================================='
Say ''
Say "  前端網址：   http://localhost:$FrontendPort/"
Say "  登入頁：     http://localhost:$FrontendPort/auth"
if ($adminDone -eq 'created' -or $adminDone -eq 'reset') {
  Say "  管理員帳號： $adminEmail"
}
Say "  管理後台：   http://localhost:$KongPort（Supabase Studio，帳密見 docker\.env）"
Say ''
Say "  同事從自己的電腦使用：http://<這台機器的 IP 或主機名稱>:$FrontendPort/"
Say "  （防火牆只需開放前端 $FrontendPort 連接埠，API 與即時協作也走此入口）"
Say "  $KongPort 是本機 API 與管理後台連接埠，不要對外開放。"
if ($KongPort -ne 8000) {
  Say ''
  Say "  （註：LIVO API 閘道使用連接埠 $KongPort——8000 在這台機器上無法使用，"
  Say '    已自動改用並同步更新前端；上面的使用網址不受影響。）'
}
Say ''
Say '  下一步：'
Say '  1. 用管理員帳號登入前端'
Say '  2. 到「系統管理」新增成員、建立第一個專案'
Say ''
Say '  常用指令（在 docker\ 目錄執行）：'
Say '  停止：docker compose -f docker-compose.yml -f compose.frontend.yml down'
Say '  啟動：docker compose -f docker-compose.yml -f compose.frontend.yml up -d'
Say '  記錄：docker compose logs -f'
if ($env:COMPOSE_PROFILES -eq 'knowledge-processor') {
  Say '  （已啟用知識庫文件匯入處理器：手動啟動／停止時在 docker compose 後加 --profile knowledge-processor）'
}
Say ''
Say "  $Support"
Say ''
exit 0
