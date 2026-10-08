// ============================================================
// LIVO — 自架版「資料庫更新」規則（scripts/build-release.mjs 使用）
// ============================================================
// 交付包裡有兩份資料庫結構：
//   schema/livo-schema.sql   全新安裝：合併全部 migration，一次跑完。
//   schema/upgrades/*.sql    既有安裝：只有「基準線之後新增」的 migration，
//                            一個 migration 一個檔案、一個交易，套用成功就記在
//                            public.livo_schema_migrations（同一個交易內）。
// install.sh / installer/install.ps1 每次執行都會比對記錄，只套用還沒記錄的
// 檔案（先自動備份資料庫）。全新安裝的 livo-schema.sql 結尾會把它合併過的
// migration 全部記錄起來，所以全新安裝不會再重跑任何更新。
//
// BASELINE_MIGRATIONS：升級機制上線（2026-10）前就存在的 migration。既有安裝
// 的 livo-schema.sql 都已包含它們，而且其中不少「不能重跑」（裸 CREATE TABLE、
// 示範資料搬遷），所以永遠不進 upgrades/。這份清單是凍結的，不要再加東西。
//
// 之後新增的 migration（不論檔名日期）一律自動成為資料庫更新，所以必須：
//   1. 冪等：重跑不出錯、結果一樣（CREATE TABLE IF NOT EXISTS、
//      ADD COLUMN IF NOT EXISTS、CREATE OR REPLACE FUNCTION、
//      INSERT ... ON CONFLICT、DROP ... IF EXISTS 再 CREATE …）。
//   2. 不刪資料：不能 DROP TABLE / DROP COLUMN / TRUNCATE / DELETE / CASCADE。
// lintUpgradeMigration() 會在打包時檢查頂層語句（DO $$ … $$ 區塊內的動態 SQL
// 檢查不到，由作者自己負責）。需要在交易外執行的語句（ALTER TYPE … ADD VALUE、
// CREATE INDEX CONCURRENTLY）要在檔案裡加一行 `-- livo:no-transaction`。
// ============================================================

// ─── 合併 schema 共用的轉換（全新安裝與資料庫更新都會套用）──────────────

// 示範成員種子必須明確以「-- [release] demo-member-seed」標記其後的
// 頂層 members INSERT … VALUES。未標記的 INSERT 可能是正式資料修補，
// 函式 / DO / 字串 / 註解中的 INSERT 則是程式內容，皆原樣保留。
// 未標記的假資料仍由 build-release 的 FAKE_MARKERS 檢查阻擋。
export function stripDemoSeeds(sql) {
  const ident = '("(?:[^\"]|\"\")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const memberValues = new RegExp(`^INSERT\\s+INTO\\s+(?:${ident}\\s*\\.\\s*)?${ident}\\s*(?:\\([^)]*\\)\\s*)?VALUES\\b`, 'i');
  const name = (value) => value?.startsWith('"') ? value.slice(1, -1).replace(/""/g, '"') : value?.toLowerCase();
  const removals = scanTopLevelStatements(sql).filter((statement) => {
    if (!statement.demoSeed || !statement.terminated) return false;
    const match = memberValues.exec(statement.text);
    return match && (!match[1] || name(match[1]) === 'public') && name(match[2]) === 'members';
  });
  const newline = sql.includes('\r\n') ? '\r\n' : '\n';
  let result = sql;
  for (const { start, end } of removals.reverse()) {
    result = result.slice(0, start) + '-- [release] 已移除示範成員種子（管理員由 install.sh / install.bat 建立）' + newline + result.slice(end);
  }
  return result;
}

// 合併 schema 的冪等化：多個 migration 定義過同名 policy（歷史開發時各檔
// 在「不同時間點」各跑一次沒事；合併成單一 SQL 連續執行時，第二個裸
// CREATE POLICY 會炸 already exists，整個安裝中斷）。這裡把「頂層」的
// CREATE POLICY 前面補 DROP POLICY IF EXISTS、頂層 ALTER PUBLICATION ...
// ADD TABLE 包 duplicate_object 防護。位於 $$ ... $$（函式/DO 區塊）內的
// 語句一律不動——逐行掃描並追蹤 dollar-quote 狀態。
export function makeIdempotent(sql) {
  const lines = sql.split('\n');
  const out = [];
  let inDollar = false;
  let dollarTag = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 追蹤 dollar-quote（支援 $$ 與 $tag$；同一行開又關則狀態不變）
    const tags = line.match(/\$[A-Za-z_]*\$/g) || [];
    let willBeInDollar = inDollar;
    for (const t of tags) {
      if (!willBeInDollar) { willBeInDollar = true; dollarTag = t; }
      else if (t === dollarTag) { willBeInDollar = false; dollarTag = ''; }
    }
    if (!inDollar) {
      const polName = line.match(/^\s*CREATE\s+POLICY\s+"([^"]+)"/i);
      if (polName) {
        // 表名可能同行（... ON table ...）或在往後幾行（多行寫法）
        let table = (line.match(/\bON\s+([A-Za-z0-9_."]+)/i) || [])[1];
        for (let j = i + 1; !table && j < Math.min(i + 4, lines.length); j++) {
          table = (lines[j].match(/^\s*ON\s+([A-Za-z0-9_."]+)/i) || [])[1];
        }
        if (table) {
          out.push(`DROP POLICY IF EXISTS "${polName[1]}" ON ${table.replace(/;$/, '')};`);
        }
        out.push(line);
        inDollar = willBeInDollar;
        continue;
      }
      const pub = line.match(/^\s*ALTER\s+PUBLICATION\s+(\S+)\s+ADD\s+TABLE\s+([A-Za-z0-9_."]+);\s*$/i);
      if (pub) {
        out.push(`DO $livo$ BEGIN ALTER PUBLICATION ${pub[1]} ADD TABLE ${pub[2]}; EXCEPTION WHEN duplicate_object THEN NULL; END $livo$;`);
        inDollar = willBeInDollar;
        continue;
      }
    }
    out.push(line);
    inDollar = willBeInDollar;
  }
  return out.join('\n');
}

// ─── 資料庫更新 ─────────────────────────────────────────────────────────

export const BASELINE_MIGRATIONS = new Set([
  '20260308173019_ad17e08d-5ca0-4d6d-b511-815ac2c1889f.sql',
  '20260308180508_a91e2892-aeb2-41fc-a0c2-4c12c4be2af5.sql',
  '20260308180659_96a45a3c-fe71-4c05-8f04-2abac041b563.sql',
  '20260308183925_0cb761c1-a821-485d-8c1b-58b9fe1c5cfa.sql',
  '20260308184321_ef153ed8-7358-4080-a7a8-ebfe8d4e069f.sql',
  '20260308185150_14e0c414-7e18-4253-a8c2-85f36c2f244e.sql',
  '20260308191404_27b049cf-dfa3-4c47-a0a4-4bce01251ae2.sql',
  '20260308191828_39c47e78-a353-41e8-842b-450be9247343.sql',
  '20260308193336_0ff0d33b-f520-4017-9563-e05efb75fba0.sql',
  '20260308210054_b57cf90a-6243-404c-8ba6-33f80afaa7bc.sql',
  '20260308210422_f9306c68-88ac-450b-abcd-32408c63a0fc.sql',
  '20260308212605_f4feac68-e806-4e30-b4fd-23c8d1f62643.sql',
  '20260308212722_74e30c14-6d5a-483e-a7d8-9dab142a38f0.sql',
  '20260308212910_78a9da34-41ad-4909-9d20-07f14d2248ee.sql',
  '20260309025701_92ed9215-2de4-483a-a2cb-39690682e950.sql',
  '20260309031437_3b9b4890-6cd6-49a0-8675-78078dfb077b.sql',
  '20260309031458_96e50274-53c3-44bc-aaa4-fb4f4c22696d.sql',
  '20260309034619_e72fd981-98c9-4727-887e-11ee70cee5f0.sql',
  '20260309050127_3f863c29-6869-4e64-a71e-043f14c0143c.sql',
  '20260309050901_1c619e19-f0ed-4931-affe-c4a4f8ff2415.sql',
  '20260309053109_df44a814-6783-40b5-845a-be811c86bf2f.sql',
  '20260309053549_7cc0d1dd-79d1-4d8f-96ee-f1c52a2d6fd6.sql',
  '20260309055325_1f586eba-5b7e-482f-919f-cae181943211.sql',
  '20260309170507_6f746087-6b6f-4704-8f41-561c924c2337.sql',
  '20260309175000_3d323b4d-cb07-4285-a93a-1bb98c45d67e.sql',
  '20260309175341_df3551a8-1ff3-4de2-93ed-00b7d0a40d46.sql',
  '20260309181512_5b7a2e90-e262-4311-b4da-d3e181042c20.sql',
  '20260310035337_625890ae-0fab-4e44-a789-3f34e2639a9b.sql',
  '20260310035616_dae1481c-0fef-46ef-9080-ff20de6054fa.sql',
  '20260310040443_606cf756-d44f-4b8b-92b0-44fa5dae6ec2.sql',
  '20260310043253_9b3f120d-9bc8-477a-b19c-c949a11c8cbd.sql',
  '20260310044327_7e8def58-e082-4b3a-a28a-7a89f825960b.sql',
  '20260310064816_18ae7dac-3003-411c-8dbe-309f1e55246e.sql',
  '20260310085848_74bd1ee9-6704-42df-8b19-c93fed17df72.sql',
  '20260310090422_a97d1f58-2174-4ea1-93e8-fc9841260011.sql',
  '20260326100000_create_field_locks.sql',
  '20260327_add_installation_id.sql',
  '20260327_add_license_key.sql',
  '20260327_add_required_fields_and_theme.sql',
  '20260327_add_slack_notify_and_reports.sql',
  '20260328_license_pg_functions.sql',
  '20260331_add_custom_fields.sql',
  '20260331_add_subtasks.sql',
  '20260331_add_task_dependencies.sql',
  '20260331_add_task_templates.sql',
  '20260331_create_orders.sql',
  '20260401_add_integration_settings.sql',
  '20260401_add_user_board_prefs.sql',
  '20260401_add_work_reports.sql',
  '20260401_notifications.sql',
  '20260401_team_settings.sql',
  '20260402_add_status_transition_rules.sql',
  '20260402_approval_workflow.sql',
  '20260402_bidirectional_integration.sql',
  '20260402_extend_task_templates.sql',
  '20260402_fix_approval_rls.sql',
  '20260402_fix_dependency_template_rls.sql',
  '20260402_fix_integration_settings_fk.sql',
  '20260402_fix_member_data.sql',
  '20260402_fix_notification_rls.sql',
  '20260402_fix_storage_policies.sql',
  '20260402_fix_work_reports_user_id.sql',
  '20260402_multichannel_send.sql',
  '20260402_smart_notification.sql',
  '20260402_smart_notification_fix_rls.sql',
  '20260402_standup_enhancement.sql',
  '20260403_fix_approval_member_rls.sql',
  '20260403_fix_notification_tables_rls.sql',
  '20260403_migrate_member_ids.sql',
  '20260404_approval_requests_nullable_rule.sql',
  '20260404_clear_stale_auth_ids.sql',
  '20260404_fix_activity_logs_id_default.sql',
  '20260404_fix_notification_templates_rls.sql',
  '20260404_fix_notifications_id_default.sql',
  '20260404_fix_sprints_id_default.sql',
  '20260404_restore_missing_statuses.sql',
  '20260404_task_requires_approval.sql',
  '20260405_fix_notifications_task_id.sql',
  '20260405_insert_required_custom_fields_default.sql',
  '20260712_notify_columns.sql',
  '20260712_slack_config.sql',
  '20260713_permission_floor.sql',
  '20260714_features_base.sql',
  '20260714_notify_dispatch.sql',
]);

export const TRACKING_TABLE = 'public.livo_schema_migrations';
export const NO_TRANSACTION_MARKER = '-- livo:no-transaction';

const NAME_RE = /^[0-9A-Za-z][0-9A-Za-z_.-]*\.sql$/;

/** 建立記錄表（冪等）。只有 service role / 安裝程式碰得到。 */
export const TRACKING_DDL = `CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
  name       text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ${TRACKING_TABLE} ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE ${TRACKING_TABLE} FROM anon, authenticated;`;

/**
 * 要做成資料庫更新的 migration：不在基準線、也沒被排除的檔案（依檔名排序）。
 * @param {string[]} migFiles  supabase/migrations/ 下的 .sql 檔名
 * @param {Set<string>|Map<string, unknown>} excluded  不進交付包的 migration
 */
export function upgradeMigrationNames(migFiles, excluded) {
  return [...migFiles]
    .filter((f) => !BASELINE_MIGRATIONS.has(f) && !excluded.has(f))
    .sort();
}

/** livo-schema.sql 結尾附加：記錄全新安裝已經包含的 migration。 */
export function trackingSeedSql(names) {
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new Error(`migration 檔名只能用英數字、_ . -：${n}`);
  }
  const rows = names.map((n) => `  ('${n}')`).join(',\n');
  return `${TRACKING_DDL}\nINSERT INTO ${TRACKING_TABLE} (name) VALUES\n${rows}\nON CONFLICT (name) DO NOTHING;\n`;
}

/** schema/upgrades/<name> 的內容：一個交易內套用並記錄。 */
export function buildUpgradeFile(name, sql) {
  if (!NAME_RE.test(name)) throw new Error(`migration 檔名只能用英數字、_ . -：${name}`);
  const inTx = !sql.includes(NO_TRANSACTION_MARKER);
  return [
    `-- LIVO 資料庫更新：${name}`,
    '-- 由 scripts/build-release.mjs 產生。install.sh / install.bat 會在既有安裝上',
    `-- 套用 ${TRACKING_TABLE} 還沒記錄的檔案，每個檔案只會成功套用一次。`,
    'SET client_min_messages = warning;  -- 重跑時的 already exists 等 NOTICE 不必顯示',
    inTx ? 'BEGIN;' : '-- （此更新含不能放在交易裡的語句，逐句執行）',
    TRACKING_DDL,
    '',
    sql.replace(/\s*$/, ''),
    '',
    `INSERT INTO ${TRACKING_TABLE} (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING;`,
    inTx ? 'COMMIT;' : '',
    '',
  ].join('\n');
}

/**
 * 把 SQL 切成「頂層語句」：去掉註解，字串 / 引號識別字 / $$ 區塊的內容換成
 * 空白佔位，讓檢查只看得到語句骨架。回傳 [{ text, line }]（line 從 1 起算）。
 */
export function splitTopLevelStatements(sql) {
  return scanTopLevelStatements(sql).map(({ text, line }) => ({ text, line }));
}

// 原始 byte ranges 僅供 seed 轉換使用；公開 lint API 保持 { text, line }。
function scanTopLevelStatements(sql) {
  const out = [];
  let cur = '';
  let line = 1;
  let startLine = 1;
  let statementStart = null;
  let demoSeed = false;
  let i = 0;
  const n = sql.length;
  const push = (terminated = false) => {
    const text = cur.replace(/\s+/g, ' ').trim();
    if (text) out.push({ text, line: startLine, start: statementStart, end: i, demoSeed, terminated });
    cur = '';
    statementStart = null;
    demoSeed = false;
  };
  const advance = (k) => {
    for (let j = 0; j < k; j++) if (sql[i + j] === '\n') line++;
    i += k;
  };
  while (i < n) {
    const c = sql[i];
    const c2 = sql.slice(i, i + 2);
    if (c2 === '--') {
      const commentStart = i;
      while (i < n && sql[i] !== '\n') i++;
      if (statementStart === null && sql.slice(commentStart, i).trim() === '-- [release] demo-member-seed') demoSeed = true;
      cur += ' ';
      continue;
    }
    if (c2 === '/*') {
      let depth = 0;
      while (i < n) {
        if (sql.slice(i, i + 2) === '/*') { depth++; advance(2); continue; }
        if (sql.slice(i, i + 2) === '*/') { depth--; advance(2); if (depth === 0) break; continue; }
        advance(1);
      }
      cur += ' ';
      continue;
    }
    if (statementStart === null && !/\s/.test(c)) { statementStart = i; startLine = line; }
    if (c === "'") {
      const escaped = /[eE]$/.test(cur) && !/[A-Za-z0-9_][eE]$/.test(cur);
      advance(1);
      while (i < n) {
        if (escaped && sql[i] === '\\') { advance(2); continue; }
        if (sql[i] === "'" && sql[i + 1] === "'") { advance(2); continue; }
        if (sql[i] === "'") { advance(1); break; }
        advance(1);
      }
      cur += "''";
      continue;
    }
    if (c === '"') {
      let ident = '';
      advance(1);
      while (i < n) {
        if (sql[i] === '"' && sql[i + 1] === '"') { ident += '"'; advance(2); continue; }
        if (sql[i] === '"') { advance(1); break; }
        ident += sql[i];
        advance(1);
      }
      cur += `"${ident}"`;
      continue;
    }
    if (c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m && !/[A-Za-z0-9_]$/.test(cur)) {
        const tag = m[0];
        advance(tag.length);
        const end = sql.indexOf(tag, i);
        advance(end < 0 ? n - i : end - i + tag.length);
        cur += `${tag} ${tag}`;
        continue;
      }
    }
    if (c === ';') {
      advance(1);
      push(true);
      continue;
    }
    cur += c;
    advance(1);
  }
  push();
  return out;
}

// ALTER TABLE 的動作清單用頂層逗號切開（括號內的逗號不算）
function splitActions(s) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const unquote = (s) => s.replace(/^"|"$/g, '').toLowerCase();

/**
 * 檢查一個將成為「資料庫更新」的 migration（已套用 makeIdempotent 之後的 SQL）。
 * 回傳問題清單（空陣列 = 通過）。
 */
export function lintUpgradeMigration(sql) {
  const problems = [];
  const noTx = sql.includes(NO_TRANSACTION_MARKER);
  const dropped = { policy: new Set(), trigger: new Set(), constraint: new Set() };
  const IDENT = '("(?:[^"]|"")+"|[A-Za-z_][A-Za-z0-9_$]*)';
  const QNAME = `${IDENT}(?:\\.${IDENT})?`;

  for (const { text: s, line } of splitTopLevelStatements(sql)) {
    const bad = (msg) => problems.push(`第 ${line} 行：${msg}\n      ${s.slice(0, 120)}`);
    const U = s.toUpperCase();

    if (/^(BEGIN|COMMIT|ROLLBACK|START TRANSACTION|END)\b/.test(U)) {
      bad('不要自己寫 BEGIN / COMMIT：打包時會替每個資料庫更新包好交易');
      continue;
    }

    // ── 不刪資料 ──
    if (/^DROP\s+(TABLE|SCHEMA|TYPE|DOMAIN|SEQUENCE|MATERIALIZED\s+VIEW)\b/.test(U)) {
      bad('資料庫更新不能刪除資料表 / 型別 / 序列（會刪到資料）');
      continue;
    }
    if (/^(TRUNCATE|DELETE\s+FROM)\b/.test(U)) {
      bad('資料庫更新不能刪除資料（TRUNCATE / DELETE）');
      continue;
    }
    if (/^UPDATE\b/.test(U) && !/\bWHERE\b/.test(U)) {
      bad('UPDATE 沒有 WHERE 會改到每一筆資料，請加上條件（只補缺的值）');
      continue;
    }
    if (/^DROP\b/.test(U) && /\bCASCADE\b/.test(U)) {
      bad('DROP … CASCADE 可能連帶刪掉其他物件，請明確列出要刪的東西');
      continue;
    }

    // ── 冪等 ──
    let m;
    if ((m = new RegExp(`^DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${IDENT}`, 'i').exec(s))) {
      dropped.policy.add(unquote(m[1]));
      continue;
    }
    if ((m = new RegExp(`^DROP\\s+TRIGGER\\s+IF\\s+EXISTS\\s+${IDENT}`, 'i').exec(s))) {
      dropped.trigger.add(unquote(m[1]));
      continue;
    }
    if (/^CREATE\s+(GLOBAL\s+|LOCAL\s+)?(TEMP|TEMPORARY|UNLOGGED\s+)?\s*TABLE\b/.test(U) && !/^CREATE\s+(\w+\s+)*TABLE\s+IF\s+NOT\s+EXISTS\b/.test(U)) {
      bad('CREATE TABLE 要寫成 CREATE TABLE IF NOT EXISTS');
    } else if (/^CREATE\s+(UNIQUE\s+)?INDEX\b/.test(U)) {
      if (!/^CREATE\s+(UNIQUE\s+)?INDEX\s+(CONCURRENTLY\s+)?IF\s+NOT\s+EXISTS\b/.test(U)) bad('CREATE INDEX 要寫成 CREATE INDEX IF NOT EXISTS');
      if (/\bCONCURRENTLY\b/.test(U) && !noTx) bad(`CREATE INDEX CONCURRENTLY 不能放在交易裡：請在檔案加一行 ${NO_TRANSACTION_MARKER}`);
    } else if (/^CREATE\s+(SCHEMA|EXTENSION|SEQUENCE)\b/.test(U) && !/^CREATE\s+(SCHEMA|EXTENSION|SEQUENCE)\s+IF\s+NOT\s+EXISTS\b/.test(U)) {
      bad('CREATE SCHEMA / EXTENSION / SEQUENCE 要加 IF NOT EXISTS');
    } else if (/^CREATE\s+(FUNCTION|PROCEDURE)\b/.test(U)) {
      bad('CREATE FUNCTION 要寫成 CREATE OR REPLACE FUNCTION');
    } else if (/^CREATE\s+VIEW\b/.test(U)) {
      bad('CREATE VIEW 要寫成 CREATE OR REPLACE VIEW');
    } else if (/^CREATE\s+MATERIALIZED\s+VIEW\b/.test(U) && !/^CREATE\s+MATERIALIZED\s+VIEW\s+IF\s+NOT\s+EXISTS\b/.test(U)) {
      bad('CREATE MATERIALIZED VIEW 要加 IF NOT EXISTS');
    } else if (/^CREATE\s+(TYPE|DOMAIN)\b/.test(U)) {
      bad('CREATE TYPE / DOMAIN 不能重跑：請包在 DO $$ BEGIN … EXCEPTION WHEN duplicate_object THEN NULL; END $$ 裡');
    } else if ((m = new RegExp(`^CREATE\\s+(CONSTRAINT\\s+)?TRIGGER\\s+${IDENT}`, 'i').exec(s))) {
      if (!dropped.trigger.has(unquote(m[2]))) bad('CREATE TRIGGER 前要先 DROP TRIGGER IF EXISTS 同名觸發器（或改用 CREATE OR REPLACE TRIGGER）');
    } else if ((m = new RegExp(`^CREATE\\s+POLICY\\s+${IDENT}`, 'i').exec(s))) {
      if (!dropped.policy.has(unquote(m[1]))) bad('CREATE POLICY 前要先 DROP POLICY IF EXISTS 同名政策');
    } else if (/^INSERT\s+INTO\b/.test(U) && !/\bON\s+CONFLICT\b/.test(U)) {
      bad('INSERT 要加 ON CONFLICT … DO NOTHING（或 DO UPDATE），重跑才不會重複或出錯');
    } else if (/^ALTER\s+TYPE\b/.test(U) && /\bADD\s+VALUE\b/.test(U)) {
      if (!/\bADD\s+VALUE\s+IF\s+NOT\s+EXISTS\b/.test(U)) bad('ALTER TYPE … ADD VALUE 要加 IF NOT EXISTS');
      if (!noTx) bad(`ALTER TYPE … ADD VALUE 新增的值在同一個交易裡不能用：請在檔案加一行 ${NO_TRANSACTION_MARKER}`);
    } else if (/^ALTER\s+TYPE\b/.test(U) && /\bRENAME\b/.test(U)) {
      bad('RENAME 重跑會失敗，請包在 DO 區塊裡先檢查');
    } else if (/^ALTER\s+PUBLICATION\b/.test(U) && /\bADD\s+TABLE\b/.test(U)) {
      bad('ALTER PUBLICATION … ADD TABLE 請寫成一行（打包時會自動包成可重跑），或自己包在 DO 區塊裡');
    } else if ((m = new RegExp(`^ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${QNAME}\\s+(.*)$`, 'i').exec(s))) {
      for (const action of splitActions(m[3])) {
        const A = action.toUpperCase();
        let c;
        if (/^DROP\s+(COLUMN\b|(?!CONSTRAINT\b|DEFAULT\b|NOT\s+NULL\b|IDENTITY\b|EXPRESSION\b)[A-Z_"])/.test(A)) {
          bad('資料庫更新不能刪除欄位（DROP COLUMN）');
        } else if ((c = new RegExp(`^DROP\\s+CONSTRAINT\\s+IF\\s+EXISTS\\s+${IDENT}`, 'i').exec(action))) {
          dropped.constraint.add(unquote(c[1]));
        } else if ((c = new RegExp(`^ADD\\s+CONSTRAINT\\s+${IDENT}`, 'i').exec(action))) {
          if (!dropped.constraint.has(unquote(c[1]))) bad('ADD CONSTRAINT 前要先 DROP CONSTRAINT IF EXISTS 同名約束（或包在 DO 區塊裡先檢查）');
        } else if (/^ADD\s+(PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY|EXCLUDE)\b/.test(A)) {
          bad('不具名的 ADD PRIMARY KEY / UNIQUE / CHECK / FOREIGN KEY 重跑會重複建立，請改用具名約束（先 DROP CONSTRAINT IF EXISTS）');
        } else if (/^ADD\b/.test(A) && !/^ADD\s+(COLUMN\s+)?IF\s+NOT\s+EXISTS\b/.test(A)) {
          bad('ADD COLUMN 要寫成 ADD COLUMN IF NOT EXISTS');
        } else if (/^RENAME\b/.test(A)) {
          bad('RENAME 重跑會失敗，請包在 DO 區塊裡先檢查');
        }
      }
    }
  }
  return problems;
}
