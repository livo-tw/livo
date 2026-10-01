#!/usr/bin/env node
// ============================================================
// LIVO — Docker 自架版 交付包打包腳本
// ============================================================
// 用法：  node scripts/build-release.mjs
//
// 產出：  release/livo-release/     （交付包 staging 目錄）
//         release/livo-release.zip  （壓縮後交給客戶）
//
// 這個腳本會：
//   1. 用 `vite build --mode customer` 編譯「客戶自架版」前端
//      （連 localhost:8000 的自架 Docker Supabase）
//   2. 組出交付包：app/（前端 + server.cjs）、docker/（自架 Supabase 設定，
//      排除 467MB 資料與上傳檔）、schema/（合併後的資料庫結構）、說明文件
//   3. 壓成 zip（路徑分隔一律 '/'，壓完讀回自檢），並印出摘要與大小
//
// 只讀取專案既有檔案，不改動任何現有檔案；所有產物都寫進 release/ 與
// _release_build/（兩者皆已列入 .gitignore）。
// ============================================================

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stripDemoSeeds,
  makeIdempotent,
  upgradeMigrationNames,
  trackingSeedSql,
  buildUpgradeFile,
  lintUpgradeMigration,
} from './release-upgrades.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(__dirname, '..');            // LIVO-local-ready/
const BUILD_OUT = path.join(APP_ROOT, '_release_build');   // vite outDir
const RELEASE_DIR = path.join(APP_ROOT, 'release');
const STAGING = path.join(RELEASE_DIR, 'livo-release');    // 交付包 staging
const ZIP_PATH = path.join(RELEASE_DIR, 'livo-release.zip');
const TEMPLATE_DIR = path.join(APP_ROOT, 'release-template');
// 出廠 docker/.env 的唯一來源（全是公開的上游佔位值，安裝時全部換掉）
const FACTORY_ENV = path.join(TEMPLATE_DIR, 'docker.env');
const DOCKER_SRC = path.join(APP_ROOT, 'docker');
const MIGRATIONS_SRC = path.join(APP_ROOT, 'supabase', 'migrations');
const SERVER_CJS_SRC = path.join(APP_ROOT, 'server.cjs');
const PROXY_CJS_SRC = path.join(APP_ROOT, 'server-proxy.cjs');

const MAX_ZIP_MB = 50; // 超過就代表有大檔漏進來（例如 db/data 467MB）

// ---------- 小工具 ----------
const log = (...a) => console.log(...a);
const step = (n, msg) => log(`\n[${n}] ${msg}`);
function die(msg, err) {
  console.error(`\n❌ ${msg}`);
  if (err) console.error(err.message || err);
  process.exit(1);
}
function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}
function humanSize(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ---------- 交付包「排雷」規則（schema 組裝用）----------
// 這些 migration 對「全新客戶安裝」是 no-op，卻內含示範成員字串
//（id / email / 中文姓名），會被下方的洩漏檢查擋下，故從合併 schema 排除；
// 原始檔仍保留在 schema/migrations/ 供進階使用者參考。
const SCHEMA_EXCLUDE = new Map([
  ['20260403_migrate_member_ids.sql',
   '純示範成員 id 改名（u-xxx → m-xxx）；全新安裝無 u-xxx 成員，整檔為 no-op'],
  ['20260404_clear_stale_auth_ids.sql',
   '清除舊示範資料的 auth_id 綁定；全新安裝 members 為空，整檔為 no-op（僅註解含示範成員資料）'],
  ['20260331_create_orders.sql',
   '賣家端 ECPay 訂單表（金流已移至雲端 worker）；客戶自架安裝不需要，且不該預載我方定價/金流結構'],
]);

// 遞迴複製並套用 filter(relPosixPath, isDir) → true 保留 / false 略過。
// 回傳 { files, dirs, bytes }。
function copyFiltered(srcRoot, destRoot, filter) {
  const stats = { files: 0, dirs: 0, bytes: 0 };
  function walk(relDir) {
    const absSrc = path.join(srcRoot, relDir);
    for (const e of fs.readdirSync(absSrc, { withFileTypes: true })) {
      const rel = relDir ? `${relDir}/${e.name}` : e.name;
      if (!filter(rel, e.isDirectory())) continue;
      const absSrcE = path.join(srcRoot, rel);
      const absDestE = path.join(destRoot, rel);
      if (e.isDirectory()) {
        fs.mkdirSync(absDestE, { recursive: true });
        stats.dirs++;
        walk(rel);
      } else if (e.isFile()) {
        fs.mkdirSync(path.dirname(absDestE), { recursive: true });
        fs.copyFileSync(absSrcE, absDestE);
        stats.files++;
        stats.bytes += fs.statSync(absSrcE).size;
      }
    }
  }
  walk('');
  return stats;
}

function copyDirPlain(srcRoot, destRoot) {
  return copyFiltered(srcRoot, destRoot, () => true);
}

// 收集目錄下所有檔案（絕對路徑 + 大小），供大小檢查用
function listFilesWithSize(root) {
  const out = [];
  function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile()) out.push({ path: abs, size: fs.statSync(abs).size });
    }
  }
  walk(root);
  return out;
}

// 讀出 zip 每個項目的原始檔名（中央目錄與對應的 local header 各一份，以 UTF-8 解碼），
// 自檢用。只處理一般 zip（非 zip64；交付包遠小於 4GB）。
function readZipEntryNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) die(`${zipPath} 不是有效的 zip（找不到中央目錄結尾）`);
  const entries = [];
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0; n--) {
    if (buf.readUInt32LE(p) !== 0x02014b50) die(`${zipPath} 的中央目錄格式不對`);
    const nameLen = buf.readUInt16LE(p + 28);
    const lh = buf.readUInt32LE(p + 42);
    if (buf.readUInt32LE(lh) !== 0x04034b50) die(`${zipPath} 的 local header 格式不對`);
    entries.push({
      central: buf.toString('utf8', p + 46, p + 46 + nameLen),
      local: buf.toString('utf8', lh + 30, lh + 30 + buf.readUInt16LE(lh + 26)),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

// 印出精簡目錄樹（限制深度）
function printTree(root, maxDepth = 2) {
  const rootName = path.basename(root);
  log(rootName + '/');
  function walk(dir, depth, prefix) {
    if (depth > maxDepth) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      const branch = last ? '└── ' : '├── ';
      if (e.isDirectory()) {
        const child = fs.readdirSync(path.join(dir, e.name));
        const count = child.length;
        log(prefix + branch + e.name + '/' + (depth === maxDepth && count ? `  (${count} 項)` : ''));
        walk(path.join(dir, e.name), depth + 1, prefix + (last ? '    ' : '│   '));
      } else {
        log(prefix + branch + e.name);
      }
    });
  }
  walk(root, 1, '');
}

// ============================================================
log('============================================================');
log('  LIVO 自架版交付包打包');
log('============================================================');

// ---------- 前置檢查 ----------
for (const [label, p] of [
  ['docker/', DOCKER_SRC],
  ['supabase/migrations/', MIGRATIONS_SRC],
  ['server.cjs', SERVER_CJS_SRC],
  ['server-proxy.cjs', PROXY_CJS_SRC],
  ['release-template/', TEMPLATE_DIR],
  ['release-template/docker.env', FACTORY_ENV],
  ['release-template/install.sh', path.join(TEMPLATE_DIR, 'install.sh')],
  ['release-template/install.bat', path.join(TEMPLATE_DIR, 'install.bat')],
  ['release-template/compose.frontend.yml', path.join(TEMPLATE_DIR, 'compose.frontend.yml')],
  ['release-template/installer/install.ps1', path.join(TEMPLATE_DIR, 'installer', 'install.ps1')],
  ['release-template/installer/create-admin.sql', path.join(TEMPLATE_DIR, 'installer', 'create-admin.sql')],
  ['release-template/installer/generate-keys.js', path.join(TEMPLATE_DIR, 'installer', 'generate-keys.js')],
  ['release-template/installer/permissions.sh', path.join(TEMPLATE_DIR, 'installer', 'permissions.sh')],
]) {
  if (!fs.existsSync(p)) die(`找不到必要來源：${label}（${p}）`);
}

// 打包會整個刪掉 release/。若有人直接在 release/livo-release 裡執行過安裝程式，
// 那裡就有這套安裝的資料庫與專屬金鑰——先停下來，絕不連資料一起刪。
const stagedEnv = path.join(STAGING, 'docker', '.env');
const installedInStaging =
  fs.existsSync(path.join(STAGING, 'docker', 'volumes', 'db', 'data')) ||
  fs.existsSync(path.join(STAGING, 'backups')) ||
  (fs.existsSync(stagedEnv) && /^LIVO_KEYS_ROTATED=1/m.test(fs.readFileSync(stagedEnv, 'utf8')));
if (installedInStaging) {
  die(
    `${STAGING} 裡有一套已經安裝過的 LIVO（資料庫或專屬金鑰），重新打包會把它整個刪掉。\n` +
    '請先把這個資料夾搬到 release/ 以外的地方再重跑打包；升級方式見 release-template/README.md「升級到新版」。'
  );
}

// 換行/BOM 正規化：sh/sql 一律 LF 無 BOM（sh 帶 CRLF 或 BOM 會直接跑不動）；
// bat 一律 CRLF；ps1 一律 CRLF + BOM（PowerShell 5.1 沒有 BOM 會把 UTF-8 中文
// 當成 ANSI 讀，訊息全變亂碼）。
const stripBom = (s) => s.replace(/^\uFEFF/, '');
const toLF = (s) => stripBom(s).replace(/\r\n/g, '\n');
const toCRLF = (s) => toLF(s).replace(/\n/g, '\r\n');

// ---------- [1] 編譯客戶版前端 ----------
step(1, '編譯客戶自架版前端（vite build --mode customer）...');
rmrf(BUILD_OUT);
const build = spawnSync(
  'npx vite build --mode customer --outDir _release_build',
  { cwd: APP_ROOT, stdio: 'inherit', shell: true }
);
if (build.status !== 0) {
  die(`前端編譯失敗（vite build 回傳 ${build.status ?? build.signal}）。請先修正編譯錯誤再重跑。`);
}
if (!fs.existsSync(path.join(BUILD_OUT, 'index.html'))) {
  die(`前端編譯似乎沒有產出（找不到 ${path.join(BUILD_OUT, 'index.html')}）。`);
}
log('  ✔ 前端編譯完成 → _release_build/');

// ---------- [2] 組裝交付包 staging ----------
step(2, '組裝交付包 → release/livo-release/ ...');
rmrf(RELEASE_DIR);
fs.mkdirSync(STAGING, { recursive: true });

// 2a. app/ — 前端 + server.cjs
const APP_DIR = path.join(STAGING, 'app');
const APP_DEMO = path.join(APP_DIR, 'demo');
fs.mkdirSync(APP_DEMO, { recursive: true });
const appStats = copyDirPlain(BUILD_OUT, APP_DEMO);
log(`  ✔ app/demo/ ← 前端（${appStats.files} 檔，${humanSize(appStats.bytes)}）`);

// server.cjs：以既有 server.cjs 為基礎，只把 ROOT 指向自己所在目錄（app/），
// 讓交付包裡 `cd app && node server.cjs` 能直接把 app/demo/ serve 在 /demo/ 下。
// （不改動專案內的原始 server.cjs；這是交付包專用的衍生檔。）
let serverSrc = fs.readFileSync(SERVER_CJS_SRC, 'utf8');
const ROOT_RE = /const ROOT = path\.join\(__dirname, "deploy-local"\);/;
if (!ROOT_RE.test(serverSrc)) {
  die('server.cjs 內容與預期不符（找不到 ROOT 定義），請確認來源檔是否被更動。');
}
serverSrc = serverSrc.replace(
  ROOT_RE,
  '// [release] 交付包裡前端就在本檔同層的 demo/ 下，故 ROOT 指向本目錄\nconst ROOT = __dirname;'
);
fs.writeFileSync(path.join(APP_DIR, 'server.cjs'), serverSrc);
fs.copyFileSync(PROXY_CJS_SRC, path.join(APP_DIR, 'server-proxy.cjs'));
log('  ✔ app/server.cjs ← server.cjs（ROOT 調整為本目錄）');

// app/index.html — 首頁自動導向 /demo/
fs.writeFileSync(path.join(APP_DIR, 'index.html'), `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="refresh" content="0; url=/demo/" />
  <title>LIVO</title>
</head>
<body>
  <p>正在前往 LIVO… 若沒有自動跳轉，<a href="/demo/">請點此進入</a>。</p>
  <script>location.replace('/demo/');</script>
</body>
</html>
`);
log('  ✔ app/index.html ← 首頁導向 /demo/');

// 2b. docker/ — 自架 Supabase 設定（排除資料 / 上傳檔 / log）
// 只帶進版控的檔案：打包機本機的 docker/.env（自己那套 Supabase 的真實密鑰）、
// Studio 存下的 SQL 片段等未追蹤檔案一律不進交付包。不是 git checkout 時
// （例如從 GitHub 下載的原始碼 zip）退回只排除 .env 與 volumes/snippets/。
const DOCKER_DEST = path.join(STAGING, 'docker');
const lsTracked = spawnSync('git', ['ls-files', '-z', '--', '.'], { cwd: DOCKER_SRC, encoding: 'utf8' });
let dockerTracked = lsTracked.status === 0 ? new Set(lsTracked.stdout.split('\0').filter(Boolean)) : null;
// 在別的 git repo 裡（例如解壓在某個 repo 底下）會回傳空清單：當成非 checkout
if (dockerTracked && !dockerTracked.has('docker-compose.yml')) dockerTracked = null;
const skippedUntracked = [];
const dockerFilter = (rel, isDir) => {
  if (!dockerRule(rel, isDir)) return false;
  if (isDir) return true;
  if (path.posix.basename(rel) === '.env') return false; // 出廠 .env 下面另外寫入
  const keep = dockerTracked ? dockerTracked.has(rel) : !rel.startsWith('volumes/snippets/');
  if (!keep) skippedUntracked.push(rel);
  return keep;
};
function dockerRule(rel, isDir) {
  const base = rel.split('/').pop();
  // 排除 467MB Postgres 資料（全新安裝從空的開始）
  if (rel === 'volumes/db/data' || rel.startsWith('volumes/db/data/')) return false;
  // 一般保險：任何 volumes 下名為 data 的目錄一律排除
  if (isDir && base === 'data' && rel.startsWith('volumes/')) return false;
  // 上傳檔：保留 storage 目錄本身，排除內容物
  if (rel === 'volumes/storage') return true;
  if (rel.startsWith('volumes/storage/')) return false;
  // log：保留 logs 目錄，但只留必要的設定檔 vector.yml
  if (rel === 'volumes/logs') return true;
  if (rel.startsWith('volumes/logs/')) return rel === 'volumes/logs/vector.yml';
  // 雜項排除
  if (base === 'node_modules' || base === '.git') return false;
  if (base && base.endsWith('.log')) return false;
  return true;
}
const dockerStats = copyFiltered(DOCKER_SRC, DOCKER_DEST, dockerFilter);
if (skippedUntracked.length) {
  log(`  ℹ docker/ 略過 ${skippedUntracked.length} 個未進版控的檔案：${skippedUntracked.join(', ')}`);
}
for (const rel of ['docker-compose.yml', 'volumes/api/kong.yml', 'volumes/logs/vector.yml', 'volumes/db/roles.sql']) {
  if (!fs.existsSync(path.join(DOCKER_DEST, rel))) die(`docker/${rel} 沒有進交付包，請檢查 docker/ 的複製規則。`);
}
// 確保 storage 目錄存在且非空（空目錄不一定每種壓縮／解壓工具都會保留；Docker bind mount 需要它）
const storageDir = path.join(DOCKER_DEST, 'volumes', 'storage');
fs.mkdirSync(storageDir, { recursive: true });
fs.writeFileSync(path.join(storageDir, '.gitkeep'), '');
// 出廠範本 docker/.env.factory：一律來自 release-template/docker.env，絕不帶打包機
// 本機的 .env。交付包刻意不附 docker/.env：安裝程式第一次執行才把範本複製成
// .env 並換上專屬金鑰；升級時把新版整包蓋過舊安裝，也不會蓋掉既有的 .env。
fs.writeFileSync(path.join(DOCKER_DEST, '.env.factory'), toLF(fs.readFileSync(FACTORY_ENV, 'utf8')));
const shippedEnv = fs.existsSync(path.join(DOCKER_DEST, '.env.factory'));
if (fs.existsSync(path.join(DOCKER_DEST, '.env'))) die('交付包不應該含 docker/.env（只附 .env.factory）。');
log(`  ✔ docker/ ← 設定檔（${dockerStats.files} 檔，${humanSize(dockerStats.bytes)}）` +
    `${shippedEnv ? '，含 .env.factory（出廠範本；第一次安裝時複製成 .env 並換上專屬金鑰）' : ''}`);

// docker/compose.frontend.yml — 前端容器 overlay（node:20-alpine 跑 server.cjs），
// 客戶主機不需要安裝 Node.js。install.sh / install.bat 會用
// `docker compose -f docker-compose.yml -f compose.frontend.yml up -d` 一起帶起。
fs.writeFileSync(
  path.join(DOCKER_DEST, 'compose.frontend.yml'),
  toLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'compose.frontend.yml'), 'utf8'))
);
log('  ✔ docker/compose.frontend.yml ← 前端容器 overlay（免裝 Node.js）');

// 2c. schema/ — 合併所有 migration 成單一檔，另附原始 migration
const SCHEMA_DEST = path.join(STAGING, 'schema');
fs.mkdirSync(SCHEMA_DEST, { recursive: true });
const migFiles = fs.readdirSync(MIGRATIONS_SRC)
  .filter(f => f.toLowerCase().endsWith('.sql'))
  .sort(); // 檔名為時間戳前綴，字典序 = 時間序
if (migFiles.length === 0) die('supabase/migrations/ 下找不到任何 .sql');
const nowIso = new Date().toISOString();
let schemaOut =
`-- ============================================================
-- LIVO 資料庫結構（自架版）
-- 由 scripts/build-release.mjs 於 ${nowIso} 自動合併產生
-- 來源：supabase/migrations/（依檔名順序）
--
-- 使用方式（一般）：直接執行 install.sh / install.bat，會自動把本檔
-- 匯入資料庫。進階／手動：在 Supabase Studio (http://localhost:8000)
-- 的 SQL Editor 全選貼上本檔內容並執行即可建立整個資料庫。
--
-- 排雷：已移除示範成員種子（20 名虛構成員），並補齊全新安裝的完整
-- 狀態種子（s1–s7），確保第一個任務不會直接落在「完成」欄。
-- ============================================================
`;
let strippedMemberSeeds = 0;
let excludedMigrations = 0;
for (const f of migFiles) {
  if (SCHEMA_EXCLUDE.has(f)) {
    excludedMigrations++;
    schemaOut +=
`\n\n-- ============================================================
-- migration: ${f}  ← [release] 已排除（${SCHEMA_EXCLUDE.get(f)}）
-- ============================================================\n`;
    continue;
  }
  schemaOut +=
`\n\n-- ============================================================
-- migration: ${f}
-- ============================================================\n`;
  let sql = fs.readFileSync(path.join(MIGRATIONS_SRC, f), 'utf8');
  const before = sql;
  sql = stripDemoSeeds(sql);
  if (sql !== before) strippedMemberSeeds++;
  sql = makeIdempotent(sql);
  schemaOut += sql.replace(/\s*$/, '') + '\n';
}

// 附加：全新安裝的完整預設狀態種子（幂等）。
// migration 只補了 s6/s7（完成/不做了），缺 s1–s5 會讓新任務直接落在「完成」欄。
// 這裡補齊 7 個狀態，數值對齊 App 預設（src/integrations/supabase/mockClient.ts 的 statuses）。
// ON CONFLICT (id) DO NOTHING → 可安全重跑，且不覆蓋客戶自訂的狀態。
schemaOut +=
`\n\n-- ============================================================
-- [release] 全新安裝預設狀態種子（由 build-release.mjs 附加）
-- 對齊 App 預設狀態；幂等，不覆蓋客戶已自訂的狀態。
-- ============================================================
INSERT INTO public.statuses (id, name, color, sort_order, is_done, auto_start, auto_done) VALUES
  ('s1', '待辦',       '#6B778C', 1, false, false, false),
  ('s2', '正在進行',   '#0065FF', 2, false, true,  false),
  ('s3', '待驗收',     '#FF8B00', 3, false, false, false),
  ('s4', '待討論確認', '#6554C0', 4, false, false, false),
  ('s5', '等待部署',   '#00B8D9', 5, false, false, false),
  ('s6', '完成',       '#36B37E', 6, true,  false, true),
  ('s7', '不做了',     '#97A0AF', 7, true,  false, true)
ON CONFLICT (id) DO NOTHING;
`;

// 附加：資料庫更新記錄（規則見 scripts/release-upgrades.mjs）。全新安裝已經
// 包含下列 migration，之後重跑安裝程式就不會再把它們當成待套用的更新。
const mergedMigrations = migFiles.filter((f) => !SCHEMA_EXCLUDE.has(f));
schemaOut +=
`\n\n-- ============================================================
-- [release] 資料庫更新記錄（由 build-release.mjs 附加）
-- 記下本檔已包含的 migration；安裝程式重跑時只套用 schema/upgrades/ 裡
-- 還沒記錄的更新。
-- ============================================================
` + trackingSeedSql(mergedMigrations);

fs.writeFileSync(path.join(SCHEMA_DEST, 'livo-schema.sql'), schemaOut);
const schemaBytes = Buffer.byteLength(schemaOut);

// schema/upgrades/ — 既有安裝的資料庫更新：基準線之後新增的 migration，
// 一檔一個交易、套用後記錄。install.sh / install.ps1 重跑時（先備份）套用。
// 這些 migration 會在客戶的正式資料上重跑，所以先檢查能否安全重跑、不刪資料。
const UPGRADES_DEST = path.join(SCHEMA_DEST, 'upgrades');
fs.mkdirSync(UPGRADES_DEST, { recursive: true });
const upgradeNames = upgradeMigrationNames(migFiles, SCHEMA_EXCLUDE);
const upgradeProblems = [];
let upgradeOut = '';
for (const f of upgradeNames) {
  const sql = makeIdempotent(stripDemoSeeds(fs.readFileSync(path.join(MIGRATIONS_SRC, f), 'utf8')));
  const problems = lintUpgradeMigration(sql);
  if (problems.length) {
    upgradeProblems.push(`  ${f}\n    - ${problems.join('\n    - ')}`);
    continue;
  }
  const file = toLF(buildUpgradeFile(f, sql));
  fs.writeFileSync(path.join(UPGRADES_DEST, f), file);
  upgradeOut += file;
}
if (upgradeProblems.length) {
  die(
    '以下 migration 會在既有安裝上當成「資料庫更新」重跑，但不能安全重跑或會刪資料：\n' +
    upgradeProblems.join('\n') +
    '\n請改成冪等寫法（規則見 scripts/release-upgrades.mjs 開頭）後再打包。'
  );
}

// 驗證：合併後的 schema 不得殘留任何虛構成員資料（種子列）。
// 只挑「僅出現在種子 INSERT」的標記；舊示範 id（u-xxx）這種只在註解出現的字串不列入。
const FAKE_MARKERS = [
  'livo.test', 'jianhong', 'yaqi', 'zhihao', 'jiarong', 'xinyi',
  '王建宏', '陳雅琪', '林佳蓉', 'm-001', 'm-002', 'm-020',
];
const leaked = FAKE_MARKERS.filter((m) => schemaOut.includes(m) || upgradeOut.includes(m));
if (leaked.length) {
  die(
    `schema/livo-schema.sql 或 schema/upgrades/ 仍殘留虛構成員資料：${leaked.join(', ')}\n` +
    `請檢查 stripDemoSeeds() / SCHEMA_EXCLUDE 是否漏掉新的種子 migration。`
  );
}
// 附上原始 migration 目錄供參考（只帶 .sql，不帶內部追蹤檔如 APPLIED.md）。
// 賣家專用的 migration 連原始檔都不帶（我方訂單/金流結構不交給客戶）。
const RAW_EXCLUDE = new Set(['20260331_create_orders.sql']);
const rawMigStats = copyFiltered(
  MIGRATIONS_SRC,
  path.join(SCHEMA_DEST, 'migrations'),
  (rel, isDir) => isDir || (rel.toLowerCase().endsWith('.sql') && !RAW_EXCLUDE.has(rel))
);
log(`  ✔ schema/livo-schema.sql ← 合併 ${migFiles.length - excludedMigrations}/${migFiles.length} 個 migration（${humanSize(schemaBytes)}）`);
log(`      • 已移除 ${strippedMemberSeeds} 個 migration 的示範成員種子；排除 ${excludedMigrations} 個純改名 migration`);
log(`      • 已附加完整狀態種子（s1–s7）；schema 驗證無虛構成員資料 ✔`);
log(`  ✔ schema/upgrades/ ← ${upgradeNames.length} 個資料庫更新（既有安裝重跑安裝程式時套用）` +
    (upgradeNames.length ? `：${upgradeNames.join(', ')}` : ''));
log(`  ✔ schema/migrations/ ← 原始檔備份（${rawMigStats.files} 檔，含被排除者供參考；賣家專用 ${migFiles.filter((f) => RAW_EXCLUDE.has(f)).length} 檔不附）`);

// 2d. 說明文件
const readmeSrc = path.join(TEMPLATE_DIR, 'README.md');
const licenseSrc = path.join(APP_ROOT, 'LICENSE'); // AGPL-3.0 全文，隨發行包附上
if (!fs.existsSync(readmeSrc)) die(`找不到 ${readmeSrc}`);
if (!fs.existsSync(licenseSrc)) die(`找不到 ${licenseSrc}`);
fs.copyFileSync(readmeSrc, path.join(STAGING, 'README.md'));
fs.copyFileSync(readmeSrc, path.join(STAGING, '部署說明.md')); // 中文檔名別名
fs.copyFileSync(licenseSrc, path.join(STAGING, 'LICENSE'));
log('  ✔ README.md / 部署說明.md / LICENSE');

// 2e. 一鍵安裝程式（腳本在交付包根目錄；輔助檔在 installer/）
// install.sh 以 LF 無 BOM 寫入（CRLF / BOM 都會讓 sh 直接跑不動）
fs.writeFileSync(
  path.join(STAGING, 'install.sh'),
  toLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'install.sh'), 'utf8'))
);
// install.bat 以 CRLF 換行寫入（Windows 批次檔慣例；內容為純 ASCII）
fs.writeFileSync(
  path.join(STAGING, 'install.bat'),
  toCRLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'install.bat'), 'utf8'))
);
// installer/install.ps1 以 CRLF + UTF-8 BOM 寫入
//（Windows PowerShell 5.1 沒有 BOM 會把 UTF-8 中文當 ANSI 讀，訊息全變亂碼）
const INSTALLER_DEST = path.join(STAGING, 'installer');
fs.mkdirSync(INSTALLER_DEST, { recursive: true });
fs.writeFileSync(
  path.join(INSTALLER_DEST, 'install.ps1'),
  '\uFEFF' + toCRLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'installer', 'install.ps1'), 'utf8'))
);
// installer/create-admin.sql 以 LF 無 BOM 寫入（會被串接在 set_config 前導之後
// 灌進 psql，中途出現 BOM 會造成 SQL 語法錯誤）
fs.writeFileSync(
  path.join(INSTALLER_DEST, 'create-admin.sql'),
  toLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'installer', 'create-admin.sql'), 'utf8'))
);
// installer/generate-keys.js 以 LF 無 BOM 寫入（安裝時經 stdin 灌進
// docker run node:20-alpine 的一次性容器，產生每套安裝專屬金鑰；純 ASCII）
fs.writeFileSync(
  path.join(INSTALLER_DEST, 'generate-keys.js'),
  toLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'installer', 'generate-keys.js'), 'utf8'))
);
fs.writeFileSync(
  path.join(INSTALLER_DEST, 'permissions.sh'),
  toLF(fs.readFileSync(path.join(TEMPLATE_DIR, 'installer', 'permissions.sh'), 'utf8'))
);
log('  ✔ install.sh（mac/Linux）/ install.bat + installer/（Windows）← 一鍵安裝程式');

// schema/first-run.sql —（可選）首次安裝初始化 SQL；存在才收進包裡，
// install.sh / install.ps1 會在套完 schema 後自動執行（冪等）。
const firstRunSrc = [
  path.join(TEMPLATE_DIR, 'first-run.sql'),
  path.join(TEMPLATE_DIR, 'schema', 'first-run.sql'),
].find((p) => fs.existsSync(p));
if (firstRunSrc) {
  fs.writeFileSync(
    path.join(SCHEMA_DEST, 'first-run.sql'),
    toLF(fs.readFileSync(firstRunSrc, 'utf8'))
  );
  log(`  ✔ schema/first-run.sql ← ${path.relative(APP_ROOT, firstRunSrc)}`);
} else {
  log('  ℹ 無 first-run.sql（release-template/ 下沒有此檔）；安裝程式會自動略過此步驟。');
}

// 最後一道防線：打包機本機 docker/.env 的密鑰值（自己那套 Supabase 的真實
// 密碼與金鑰）不准出現在交付包任何檔案裡。和出廠範本相同的公開佔位值不算。
// 只印鍵名與檔名，不印值。
const parseEnv = (text) => text.split(/\r?\n/)
  .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l))
  .filter(Boolean)
  .map((m) => [m[1], m[2].trim().replace(/^['"]|['"]$/g, '')]);
const localEnvPath = path.join(DOCKER_SRC, '.env');
if (fs.existsSync(localEnvPath)) {
  const factoryValues = new Set(parseEnv(fs.readFileSync(FACTORY_ENV, 'utf8')).map(([, v]) => v));
  const localSecrets = parseEnv(fs.readFileSync(localEnvPath, 'utf8'))
    .filter(([k, v]) => /KEY|SECRET|PASS|TOKEN|JWT/.test(k) && v.length >= 8 && !factoryValues.has(v));
  const hits = [];
  (function scanDir(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scanDir(p); continue; }
      const text = fs.readFileSync(p, 'latin1');
      for (const [k, v] of localSecrets) if (text.includes(v)) hits.push(`${k} → ${path.relative(STAGING, p)}`);
    }
  })(STAGING);
  if (hits.length) die(`交付包含有打包機本機 docker/.env 的密鑰（只列鍵名）：\n  ${hits.join('\n  ')}`);
  log(`  ✔ 交付包不含打包機本機 docker/.env 的密鑰（檢查 ${localSecrets.length} 個值）`);
}

// ---------- [3] 壓縮成 zip ----------
step(3, '壓縮 → release/livo-release.zip ...');
rmrf(ZIP_PATH);
if (process.platform === 'win32') {
  // 不用 Compress-Archive：Windows PowerShell 5.1 內建的 Archive 模組（1.0.1.0）把路徑
  // 寫成反斜線（livo-release\docker\.env），違反 ZIP 規格 APPNOTE 4.4.17（一律用 '/'）。
  // Info-ZIP unzip 會警告後自動轉換，但 Python zipfile 這類照規格解讀的工具會把整包
  // 攤平成一堆檔名帶 '\' 的檔案，客戶照 README 跑 install.sh 就找不到檔案。
  // 改用 .NET ZipFile.CreateFromDirectory，並關掉 UseBackslash 相容開關（在 PowerShell 5.1
  // 裡預設是開的，不關一樣寫反斜線）。其餘和 Compress-Archive 相同：頂層資料夾
  // livo-release/、中文檔名 UTF-8、保留空目錄、不帶 Unix 權限。
  // Windows 內建 tar.exe 不適合：它把檔案記成 Unix 權限 0666、目錄 0777（Linux 用 unzip
  // 解壓後連 docker/.env 都人人可寫），中文檔名預設寫成本機 ANSI 碼頁（如 Big5）。
  // 路徑走環境變數，免處理引號跳脫。
  const psCmd = [
    "$ErrorActionPreference = 'Stop'",
    "[AppContext]::SetSwitch('Switch.System.IO.Compression.ZipFile.UseBackslash', $false)",
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    '[IO.Compression.ZipFile]::CreateFromDirectory($env:LIVO_ZIP_SRC, $env:LIVO_ZIP_DEST, ' +
      '[IO.Compression.CompressionLevel]::Optimal, $true)',
  ].join('; ');
  const zip = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', psCmd], {
    stdio: 'inherit',
    env: { ...process.env, LIVO_ZIP_SRC: STAGING, LIVO_ZIP_DEST: ZIP_PATH },
  });
  if (zip.status !== 0) die(`ZipFile.CreateFromDirectory 失敗（回傳 ${zip.status ?? zip.signal}）`);
} else {
  // 非 Windows 後備：用 zip -r
  const zip = spawnSync('zip', ['-r', '-q', ZIP_PATH, 'livo-release'],
    { cwd: RELEASE_DIR, stdio: 'inherit' });
  if (zip.status !== 0) die(`zip 失敗（回傳 ${zip.status ?? zip.signal}）。請確認系統有安裝 zip。`);
}
if (!fs.existsSync(ZIP_PATH)) die('壓縮後找不到 zip 檔');
const zipBytes = fs.statSync(ZIP_PATH).size;

// 自檢：讀回 zip，任何項目名稱含 '\' 就中止（中央目錄與 local header 都看，
// 解壓工具有的讀前者、有的讀後者）；再確認檔案清單和 staging 完全一致
//（沒有漏檔，中文檔名也沒變亂碼）。
const zipEntries = readZipEntryNames(ZIP_PATH);
const backslashed = zipEntries.filter((e) => e.central.includes('\\') || e.local.includes('\\'));
if (backslashed.length) {
  die(`zip 內有 ${backslashed.length} 個項目名稱含反斜線（ZIP 規格要求用 '/'，不少解壓工具會把目錄攤平）：\n  ` +
      backslashed.slice(0, 5).map((e) => e.central).join('\n  '));
}
const zipFiles = new Set(zipEntries.map((e) => e.central).filter((n) => !n.endsWith('/')));
const stagingFiles = listFilesWithSize(STAGING)
  .map((f) => ['livo-release', ...path.relative(STAGING, f.path).split(path.sep)].join('/'));
const notInZip = stagingFiles.filter((n) => !zipFiles.has(n));
if (notInZip.length || zipFiles.size !== stagingFiles.length) {
  die(`zip 的檔案清單和 staging 不一致（staging ${stagingFiles.length} 檔／zip ${zipFiles.size} 檔）` +
      (notInZip.length ? `，zip 缺：\n  ${notInZip.slice(0, 5).join('\n  ')}` : ''));
}
log(`  ✔ 自檢：${zipEntries.length} 個項目路徑都用 '/'，${zipFiles.size} 個檔案與 staging 一致`);

// ---------- [4] 摘要 ----------
step(4, '完成摘要');
log('\n── 交付包內容 ──');
printTree(STAGING, 2);

log('\n── 已排除（不進交付包）──');
log('  • docker/volumes/db/data/     （Postgres 資料 ~467MB，全新安裝從空的開始）');
log('  • docker/volumes/storage/內容  （使用者上傳檔）');
log('  • docker/volumes/logs/ 內容    （僅保留 vector.yml 設定）');
log('  • node_modules / .git / *.log');

log('\n── 產物 ──');
log(`  staging：${STAGING}`);
log(`  ZIP    ：${ZIP_PATH}`);
log(`  ZIP 大小：${humanSize(zipBytes)}`);

const zipMB = zipBytes / 1024 / 1024;
if (zipMB > MAX_ZIP_MB) {
  log(`\n⚠️  ZIP 超過 ${MAX_ZIP_MB}MB，可能有大檔漏入。staging 內最大的 10 個檔案：`);
  const files = listFilesWithSize(STAGING).sort((a, b) => b.size - a.size).slice(0, 10);
  for (const f of files) {
    log(`     ${humanSize(f.size).padStart(10)}  ${path.relative(STAGING, f.path)}`);
  }
} else {
  log(`\n✔ ZIP 大小正常（< ${MAX_ZIP_MB}MB）。`);
}

if (shippedEnv) {
  log('\nℹ️  docker/.env.factory 內的金鑰只是出廠預設值：install.sh / install.bat 會在');
  log('    第一次安裝時複製成 docker/.env，並產生每套安裝專屬的 JWT_SECRET / ANON_KEY /');
  log('    SERVICE_ROLE_KEY / POSTGRES_PASSWORD / DASHBOARD_PASSWORD，並同步');
  log('    改寫前端 bundle 內嵌的 anon key（installer/generate-keys.js）。');
}

log('\n✅ 打包完成。把 release/livo-release.zip 交給客戶即可。\n');
