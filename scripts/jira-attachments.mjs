#!/usr/bin/env node
// Jira 附件匯入工具：把 Jira Cloud 站台備份裡的附件上傳到 LIVO，掛回對應的
// 任務，並把描述 / 留言裡的內嵌圖換成 LIVO 的圖片連結。
// 先在 LIVO 的「資料匯入」匯入同一份 CSV，再執行這支工具。
// 用法見 `node scripts/jira-attachments.mjs --help`。

import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadJiraCsv } from './lib/load-jira-csv.mjs';
import { openBackup } from './lib/jira-backup.mjs';
import { connectLivo } from './lib/livo-client.mjs';
import {
  contentTypeFor,
  formatSize,
  parseSize,
  replaceInlineImages,
  reportCsv,
  storagePathFor,
} from './lib/jira-attachments-core.mjs';

const HELP = `Jira 附件匯入工具（Jira Cloud 站台備份 → LIVO）

先在 LIVO「系統管理 → 資料匯入」匯入 CSV，再用同一份 CSV 執行：

  node scripts/jira-attachments.mjs --csv <匯出的.csv> --backup <站台備份.zip 或解壓資料夾> [選項]

連線（擇一）：
  --api <網址>          Cloudflare 版 API，例如 https://api.livo-tw.com（就是前端的 VITE_API_URL）
  --supabase <網址>      Docker 版對外網址（docker/.env 的 SUPABASE_PUBLIC_URL），例如 http://localhost:8000
  --anon-key <金鑰>      Docker 版的 ANON_KEY（docker/.env），或環境變數 LIVO_ANON_KEY

登入（擇一，需要管理員）：
  --token <API 金鑰>     livo_pat_ 開頭的個人 API 金鑰，或環境變數 LIVO_TOKEN；金鑰要綁定管理員。
                        Docker 版會自動換成 15 分鐘的權杖，到期前自動重換
  --email <管理員 Email>  密碼會在終端機詢問，或用環境變數 LIVO_PASSWORD

其他：
  --dry-run             只檢查：比對 CSV 與備份，列出找不到的檔案和超過上限的檔案；不連線、不上傳
  --max-size <大小>      單檔上限，超過就跳過並列在清單裡（預設 Cloudflare 20MB、Docker 200MB；
                        Docker 的上限是 docker/.env 的 FILE_SIZE_LIMIT，調高過就跟著調）
  --time-zone <時區>     CSV 時間的時區（IANA 名稱，預設 Asia/Taipei），用於附件的上傳時間
  --report <檔案>        結果清單 CSV（預設 jira-attachments-report.csv）
  -h, --help            顯示這段說明

說明：
  - 附件在備份裡的位置是 data/attachments/<專案>/<…>/<Issue key>/<附件 ID>；工具一律用附件 ID
    在整個 attachments 資料夾裡找檔，所以改過代號的專案也找得到。
  - 原始檔名取自 CSV 的附件欄（Attachment／附件）。
  - 已經上傳過的附件（同任務、同檔名、同大小）會跳過，中斷後可以直接重跑。
  - 超過上限、備份裡找不到、或 LIVO 裡找不到任務的附件都會跳過並寫進清單，不會中斷整批。
`;

const SPEC = {
  csv: { type: 'string' },
  backup: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  api: { type: 'string' },
  supabase: { type: 'string' },
  'anon-key': { type: 'string' },
  token: { type: 'string' },
  email: { type: 'string' },
  'max-size': { type: 'string' },
  'time-zone': { type: 'string', default: 'Asia/Taipei' },
  report: { type: 'string', default: 'jira-attachments-report.csv' },
  help: { type: 'boolean', short: 'h', default: false },
};

function die(msg) {
  console.error(`錯誤：${msg}`);
  process.exit(1);
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) die('需要密碼：請設定環境變數 LIVO_PASSWORD，或在終端機直接執行以輸入密碼');
  process.stdout.write(question);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          process.stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.resume();
    stdin.on('data', onData);
  });
}

const chunks = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

async function main() {
  let values;
  try {
    ({ values } = parseArgs({ options: SPEC, allowPositionals: false }));
  } catch (err) {
    die(`${err.message}\n\n${HELP}`);
  }
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.csv || !values.backup) die(`需要 --csv 和 --backup\n\n${HELP}`);
  const dryRun = values['dry-run'];
  if (!dryRun && !values.api && !values.supabase) die('請指定 --api（Cloudflare 版）或 --supabase（Docker 版），或先用 --dry-run 檢查');
  const explicitMax = parseSize(values['max-size']);
  if (Number.isNaN(explicitMax)) die(`--max-size 看不懂：${values['max-size']}`);

  // ── CSV ──
  const jira = await loadJiraCsv();
  const timeZone = jira.validTimeZone(values['time-zone']);
  if (!timeZone) die(`--time-zone 不是有效的 IANA 時區：${values['time-zone']}`);
  const parsed = jira.parseJiraExport(await fs.readFile(values.csv, 'utf8'), { timeZone });
  if (!parsed.ok) {
    if (parsed.error === 'no_data_rows') die('CSV 沒有任何資料列');
    die(`CSV 缺少必要欄位：${parsed.missing.map((m) => m.accepted.join(' / ')).join('、')}`);
  }
  if (!parsed.columns.all.attachment?.length) die('CSV 沒有附件欄（Attachment／附件）');
  const items = [];
  for (const issue of parsed.issues) {
    const seen = new Set();
    for (const att of issue.attachments) {
      if (seen.has(att.id)) continue;
      seen.add(att.id);
      items.push({ issue, att });
    }
  }
  console.log(`CSV：${parsed.issues.length} 個任務、${items.length} 個附件`);
  if (items.length === 0) return;

  // ── Backup ──
  const backup = await openBackup(values.backup);
  console.log(`備份：找到 ${backup.files.size} 個附件檔${backup.duplicates.length ? `（${backup.duplicates.length} 個 ID 重複，取第一個）` : ''}`);

  const maxBytes = explicitMax ?? (values.api ? 20 * 1024 * 1024 : 200 * 1024 * 1024);
  console.log(
    `單檔上限：${formatSize(maxBytes)}${explicitMax === null ? `（${values.api ? 'Cloudflare' : 'Docker'} 版預設，可用 --max-size 調整）` : ''}`,
  );

  const rows = items.map(({ issue, att }) => {
    const file = backup.files.get(att.id);
    const row = {
      issue_key: issue.key,
      attachment_id: att.id,
      file_name: att.fileName,
      size_bytes: file ? file.size : '',
      status: 'pending',
      detail: '',
      livo_path: '',
    };
    if (!file) row.status = 'missing_in_backup';
    else if (file.size > maxBytes) {
      row.status = 'too_large';
      row.detail = `${formatSize(file.size)} > ${formatSize(maxBytes)}`;
    }
    return { row, issue, att, file };
  });

  if (dryRun) {
    for (const r of rows) if (r.row.status === 'pending') r.row.status = 'ready';
    await finish(rows, values.report, backup, true);
    return;
  }

  // ── LIVO ──
  const token = (values.token || process.env.LIVO_TOKEN || '').trim();
  let password = '';
  if (!token) {
    if (!values.email) die('請用 --token（API 金鑰）或 --email（管理員帳號）登入');
    password = process.env.LIVO_PASSWORD || (await promptHidden(`${values.email} 的密碼：`));
  }
  const livo = await connectLivo({
    api: values.api,
    supabase: values.supabase,
    anonKey: values['anon-key'] || process.env.LIVO_ANON_KEY,
    token,
    email: values.email,
    password,
  });
  if (explicitMax !== null && explicitMax > livo.maxUploadBytes) {
    console.warn(
      livo.kind === 'docker'
        ? `注意：--max-size 大於 Docker 預設的上傳上限 ${formatSize(livo.maxUploadBytes)}；docker/.env 的 FILE_SIZE_LIMIT 有調高才收得下，否則較大的檔案會上傳失敗並列在清單裡。`
        : `注意：--max-size 大於這個後端的上傳上限 ${formatSize(livo.maxUploadBytes)}，較大的檔案會上傳失敗並列在清單裡。`,
    );
  }

  const keys = Array.from(new Set(rows.map((r) => r.issue.key)));
  const taskIdByKey = new Map();
  for (const part of chunks(keys, 100)) {
    for (const t of await livo.select('tasks', 'id,task_key', { task_key: part })) taskIdByKey.set(t.task_key, t.id);
  }
  const taskIds = Array.from(new Set(taskIdByKey.values()));
  const existing = new Map(); // task|name|size → storage path
  for (const part of chunks(taskIds, 100)) {
    for (const a of await livo.select('task_attachments', 'task_id,file_name,file_size,storage_path', { task_id: part })) {
      existing.set(`${a.task_id}\u0000${a.file_name}\u0000${a.file_size}`, a.storage_path);
    }
  }
  const members = await livo.select('members', 'id,name,email');
  const memberByPerson = new Map(members.map((m) => [jira.personKey(m.name), m.id]));
  const me =
    (livo.memberId && members.find((m) => m.id === livo.memberId)) ||
    (livo.loginEmail ? members.find((m) => (m.email || '').toLowerCase() === livo.loginEmail.toLowerCase()) : null);

  // ── Upload ──
  const urlsByTask = new Map(); // task id → Map(file name → { url, at })
  const remember = (taskId, name, url, at) => {
    const m = urlsByTask.get(taskId) || new Map();
    const prev = m.get(name);
    if (!prev || (at || '') >= (prev.at || '')) m.set(name, { url, at }); // the newest same-name file wins, like Jira
    urlsByTask.set(taskId, m);
  };
  const pending = rows.filter((r) => r.row.status === 'pending');
  let done = 0;
  for (const r of rows) {
    if (r.row.status !== 'pending') continue;
    const taskId = taskIdByKey.get(r.issue.key);
    if (!taskId) {
      r.row.status = 'task_not_found';
      r.row.detail = '請先在 LIVO 匯入這份 CSV';
      continue;
    }
    const dupKey = `${taskId}\u0000${r.att.fileName}\u0000${r.file.size}`;
    if (existing.has(dupKey)) {
      r.row.status = 'already_uploaded';
      r.row.livo_path = existing.get(dupKey);
      remember(taskId, r.att.fileName, livo.publicUrl('task-images', r.row.livo_path), r.att.uploadedAt);
      continue;
    }
    done++;
    process.stdout.write(`[${done}/${pending.length}] ${r.issue.key} ${r.att.fileName} (${formatSize(r.file.size)}) … `);
    try {
      const bytes = await r.file.read();
      const contentType = contentTypeFor(r.att.fileName);
      const storagePath = await livo.upload('task-images', storagePathFor(taskId, r.att.fileName), bytes, contentType);
      const uploaderKey = parsed.accountPeople[r.att.uploaderAccountId];
      await livo.insert('task_attachments', {
        task_id: taskId,
        file_name: r.att.fileName,
        file_size: bytes.length,
        file_type: contentType,
        storage_path: storagePath,
        uploaded_by: (uploaderKey && memberByPerson.get(uploaderKey)) || me?.id || '',
        ...(r.att.uploadedAt ? { created_at: r.att.uploadedAt } : {}),
      });
      existing.set(dupKey, storagePath);
      r.row.status = 'uploaded';
      r.row.livo_path = storagePath;
      remember(taskId, r.att.fileName, livo.publicUrl('task-images', storagePath), r.att.uploadedAt);
      console.log('完成');
    } catch (err) {
      r.row.status = 'failed';
      r.row.detail = err.message;
      console.log(`失敗：${err.message}`);
    }
  }

  // ── Inline images in descriptions and comments ──
  let replacedTotal = 0;
  let rowsUpdated = 0;
  for (const [taskId, files] of urlsByTask) {
    const urlByName = new Map(Array.from(files.entries()).map(([name, v]) => [name, v.url]));
    try {
      for (const spec of await livo.select('task_specs', 'id,background,requirement,notes', { task_id: taskId })) {
        const patch = {};
        for (const col of ['background', 'requirement', 'notes']) {
          const { html, replaced } = replaceInlineImages(spec[col] || '', urlByName);
          if (replaced) {
            patch[col] = html;
            replacedTotal += replaced;
          }
        }
        if (Object.keys(patch).length) {
          await livo.update('task_specs', spec.id, patch);
          rowsUpdated++;
        }
      }
      for (const comment of await livo.select('comments', 'id,content', { task_id: taskId })) {
        const { html, replaced } = replaceInlineImages(comment.content || '', urlByName);
        if (replaced) {
          await livo.update('comments', comment.id, { content: html });
          replacedTotal += replaced;
          rowsUpdated++;
        }
      }
    } catch (err) {
      console.warn(`內嵌圖替換失敗（${taskId}）：${err.message}`);
    }
  }
  console.log(`內嵌圖：替換 ${replacedTotal} 處（更新 ${rowsUpdated} 筆描述／留言）`);

  await finish(rows, values.report, backup, false);
}

async function finish(rows, reportPath, backup, dryRun) {
  await backup.close();
  await fs.writeFile(reportPath, reportCsv(rows.map((r) => r.row)));
  const count = {};
  for (const r of rows) count[r.row.status] = (count[r.row.status] || 0) + 1;
  const label = {
    ready: '可以上傳', uploaded: '已上傳', already_uploaded: '之前已上傳', too_large: '超過上限，跳過',
    missing_in_backup: '備份裡找不到', task_not_found: 'LIVO 裡找不到任務', failed: '失敗',
  };
  console.log(`\n${dryRun ? '檢查結果' : '結果'}：`);
  for (const [status, n] of Object.entries(count)) console.log(`  ${label[status] || status}：${n}`);
  const tooLarge = rows.filter((r) => r.row.status === 'too_large');
  if (tooLarge.length) {
    console.log('\n超過上限而跳過的檔案（請另外處理，例如放到雲端硬碟後在任務裡貼連結）：');
    for (const r of tooLarge) console.log(`  ${r.issue.key}  ${r.att.id}  ${r.att.fileName}  ${r.row.detail}`);
  }
  const missing = rows.filter((r) => r.row.status === 'missing_in_backup');
  if (missing.length) {
    console.log('\n備份裡找不到的附件：');
    for (const r of missing.slice(0, 50)) console.log(`  ${r.issue.key}  ${r.att.id}  ${r.att.fileName}`);
    if (missing.length > 50) console.log(`  …另有 ${missing.length - 50} 個，見清單`);
  }
  console.log(`\n完整清單：${path.resolve(reportPath)}`);
  if (rows.some((r) => r.row.status === 'failed')) process.exitCode = 2;
}

main().catch((err) => die(err.message));
