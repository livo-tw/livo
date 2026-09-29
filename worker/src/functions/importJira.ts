// Port of supabase/functions/import-jira/index.ts — Jira CSV importer.
// Destructively clears task data, then imports tasks/comments/specs/sprints
// from a Chinese-header Jira CSV export. Professional-license gated.

import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { DEFAULT_WORKSPACE } from '../env';
import { TABLES } from '../tables';
import { valueToDb, nowIso } from '../meta';
import { notifyChanges } from '../notify';
import { checkProfessional } from '../license';

// ── SQL identifier guard (all interpolated identifiers must pass) ──
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

// ── License gate: professional tier required (shared canonical check) ──

// ── Chinese date parsing ──
const monthMap: Record<string, number> = {
  '一月': 0, '二月': 1, '三月': 2, '四月': 3, '五月': 4, '六月': 5,
  '七月': 6, '八月': 7, '九月': 8, '十月': 9, '十一月': 10, '十二月': 11,
};

function parseChineseDateTime(s: string): string | null {
  if (!s?.trim()) return null;
  const m = s.match(/(\d+)\/([一-鿿]+)\/(\d+)\s+(\d+):(\d+)\s*(上午|下午)/);
  if (!m) return null;
  const day = m[1] || '';
  const mCh = m[2] || '';
  const yr = m[3] || '';
  const hr = m[4] || '';
  const min = m[5] || '';
  const ap = m[6] || '';
  const month = monthMap[mCh];
  if (month === undefined) return null;
  let h = parseInt(hr);
  if (ap === '下午' && h !== 12) h += 12;
  if (ap === '上午' && h === 12) h = 0;
  const d = new Date(2000 + parseInt(yr), month, parseInt(day), h, parseInt(min));
  return d.toISOString().slice(0, 19) + 'Z';
}

function parseDateOnly(s: string): string | null {
  if (!s?.trim()) return null;
  const m = s.match(/(\d+)\/([一-鿿]+)\/(\d+)/);
  if (!m) return null;
  const day = m[1] || '';
  const mCh = m[2] || '';
  const yr = m[3] || '';
  const month = monthMap[mCh];
  if (month === undefined) return null;
  return `${2000 + parseInt(yr)}-${String(month + 1).padStart(2, '0')}-${String(parseInt(day)).padStart(2, '0')}`;
}

/** "2026-04-01T..." → "2026-04-01"; strings without 'T' pass through unchanged. */
function dateOnlyPart(s: string): string {
  const i = s.indexOf('T');
  return i >= 0 ? s.slice(0, i) : s;
}

// ── Simple CSV parser that handles quoted multi-line fields ──
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  const len = text.length;

  // Remove BOM
  if (text.charCodeAt(0) === 0xfeff) i = 1;

  while (i < len) {
    const row: string[] = [];
    while (i < len) {
      if (text[i] === '"') {
        // Quoted field
        i++; // skip opening quote
        let field = '';
        while (i < len) {
          if (text[i] === '"') {
            if (i + 1 < len && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++; // skip closing quote
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = '';
        while (i < len && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          field += text[i];
          i++;
        }
        row.push(field);
      }

      if (i < len && text[i] === ',') {
        i++; // skip comma
      } else {
        break; // end of row
      }
    }
    // Skip newline(s)
    while (i < len && (text[i] === '\r' || text[i] === '\n')) i++;

    if (row.length > 1 || (row.length === 1 && row[0] !== '')) {
      rows.push(row);
    }
  }
  return rows;
}

// ── Convert Jira wiki markup / markdown-ish to HTML ──
function textToHtml(text: string, jiraIdToName?: Record<string, string>, memberMap?: Record<string, string>): string {
  if (!text) return '';

  // If content already contains HTML tags (like <p>, <h2>), return as-is
  // but still process mentions
  if (/<[a-z][\s\S]*>/i.test(text)) {
    // Still resolve mentions in existing HTML
    let html = text;
    if (jiraIdToName && memberMap) {
      html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m: string, accId: string) => {
        const name = jiraIdToName[accId.trim()];
        if (name) {
          const memberId = memberMap[name] || '';
          return `<span class="mention" data-id="${memberId}">@${name}</span>`;
        }
        return '@unknown';
      });
    }
    html = html.replace(/@user/g, '@成員');
    return html;
  }

  // Process line by line for Jira wiki markup
  const lines = text.split('\n');
  const result: string[] = [];
  let inList = false;
  let listLevel = 0;
  let inTable = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    // Jira table header row: ||col1||col2||
    if (/^\|\|.+\|\|/.test(line)) {
      if (inList) { for (let d = listLevel; d > 0; d--) result.push('</ul>'); inList = false; listLevel = 0; }
      if (!inTable) { result.push('<table>'); inTable = true; }
      const cells = line.split('||').filter((c) => c !== '');
      result.push('<tr>' + cells.map((c) => `<th>${processInline(c.trim(), jiraIdToName, memberMap)}</th>`).join('') + '</tr>');
      continue;
    }

    // Jira table data row: |col1|col2|
    if (/^\|[^|]/.test(line) && line.endsWith('|')) {
      if (inList) { for (let d = listLevel; d > 0; d--) result.push('</ul>'); inList = false; listLevel = 0; }
      if (!inTable) { result.push('<table>'); inTable = true; }
      const cells = line.slice(1, -1).split('|');
      result.push('<tr>' + cells.map((c) => `<td>${processInline(c.trim(), jiraIdToName, memberMap)}</td>`).join('') + '</tr>');
      continue;
    }

    // Close table if we're no longer in table rows
    if (inTable) { result.push('</table>'); inTable = false; }

    // Jira headings: h1. h2. h3. h4. h5. h6.
    const headingMatch = line.match(/^h([1-6])\.\s+(.+)$/);
    if (headingMatch) {
      if (inList) { result.push('</ul>'); inList = false; }
      const level = headingMatch[1] || '1';
      const content = processInline(headingMatch[2] || '', jiraIdToName, memberMap);
      result.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Jira bullet lists: * item, ** sub-item, *** sub-sub-item
    const bulletMatch = line.match(/^(\*+)\s+(.+)$/);
    if (bulletMatch) {
      const depth = (bulletMatch[1] || '*').length;
      const content = processInline(bulletMatch[2] || '', jiraIdToName, memberMap);
      if (!inList) { result.push('<ul>'); inList = true; listLevel = depth; }
      else if (depth > listLevel) { result.push('<ul>'); listLevel = depth; }
      else if (depth < listLevel) {
        for (let d = listLevel; d > depth; d--) result.push('</ul>');
        listLevel = depth;
      }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Jira numbered lists: # item, ## sub-item
    const numberedMatch = line.match(/^(#+)\s+(.+)$/);
    if (numberedMatch) {
      const content = processInline(numberedMatch[2] || '', jiraIdToName, memberMap);
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style bullet: - item
    const mdBulletMatch = line.match(/^-\s+(.+)$/);
    if (mdBulletMatch) {
      const content = processInline(mdBulletMatch[1] || '', jiraIdToName, memberMap);
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style numbered: 1. item
    const mdNumMatch = line.match(/^\d+\.\s+(.+)$/);
    if (mdNumMatch) {
      const content = processInline(mdNumMatch[1] || '', jiraIdToName, memberMap);
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Close list if we hit a non-list line
    if (inList) {
      for (let d = listLevel; d > 0; d--) result.push('</ul>');
      inList = false;
      listLevel = 0;
    }

    // Empty line → paragraph break
    if (line.trim() === '') {
      continue;
    }

    // Horizontal rule: ----
    if (/^-{4,}$/.test(line.trim())) {
      result.push('<hr/>');
      continue;
    }

    // Regular paragraph line
    result.push(`<p>${processInline(line, jiraIdToName, memberMap)}</p>`);
  }

  // Close any remaining structures
  if (inTable) result.push('</table>');
  if (inList) {
    for (let d = listLevel; d > 0; d--) result.push('</ul>');
  }

  return result.join('\n');
}

// Process inline Jira wiki markup
function processInline(text: string, jiraIdToName?: Record<string, string>, memberMap?: Record<string, string>): string {
  // Escape HTML entities first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Jira bold: *text*  (but not ** which is sub-bullet)
  html = html.replace(/\*([^\s*][^*]*[^\s*])\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^\s*])\*/g, '<strong>$1</strong>');

  // Markdown bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Jira italic: _text_
  html = html.replace(/_([^\s_][^_]*[^\s_])_/g, '<em>$1</em>');
  html = html.replace(/_([^\s_])_/g, '<em>$1</em>');

  // Jira strikethrough: -text- (strict + safe mode to avoid corrupting URLs / links / tech tokens)
  html = html.replace(
    /(^|[\s([{「『“‘"'`])-([^\n\r\-]{1,60}?)-(?=$|[\s)\]}」』”’"'`.,;!?])/g,
    (full: string, prefix: string, inner: string) => {
      const value = String(inner || '').trim();
      if (!value) return full;
      if (/(https?:\/\/|www\.|\.com|\.net|\.org|\.io|@|\/|\\|\|)/i.test(value)) return full;
      return `${prefix}<s>${value}</s>`;
    }
  );

  // Markdown strikethrough: ~~text~~
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Jira inline code: {{text}}
  html = html.replace(/\{\{(.+?)\}\}/g, '<code>$1</code>');

  // Markdown inline code: `text`
  html = html.replace(/`(.+?)`/g, '<code>$1</code>');

  // Jira color: {color:#hex}text{color}
  html = html.replace(/\{color:(#[0-9a-fA-F]+)\}(.*?)\{color\}/g, '<span style="color:$1">$2</span>');

  // Jira images: !image.png|width=X,height=Y! → [image]
  html = html.replace(/!([^|!]+)\|[^!]*!/g, '[圖片: $1]');
  html = html.replace(/!([^!]+)!/g, '[圖片: $1]');

  // Jira links: [text|url] or [url]
  html = html.replace(/\[([^|]+)\|([^\]]+)\]/g, '<a href="$2">$1</a>');
  html = html.replace(/\[(https?:\/\/[^\]]+)\]/g, '<a href="$1">$1</a>');

  // Jira user mentions: [~accountid:xxx] → resolve to actual name
  if (jiraIdToName && memberMap) {
    html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m: string, accId: string) => {
      const name = jiraIdToName[accId.trim()];
      if (name) {
        const memberId = memberMap[name] || '';
        return `<span class="mention" data-id="${memberId}">@${name}</span>`;
      }
      return '@成員';
    });
  } else {
    html = html.replace(/\[~accountid:[^\]]+\]/g, '@成員');
  }
  return html;
}

// ── Priority mapping ──
function mapPriority(p: string): string {
  const m: Record<string, string> = {
    'Highest': 'highest', 'High': 'high', 'Medium': 'medium',
    'Low': 'low', 'Lowest': 'lowest',
  };
  return m[p] || 'medium';
}

// ── Status mapping (Jira → DB status ID) ──
function mapStatusId(s: string): string {
  const m: Record<string, string> = {
    '待办': 's1', '待辦': 's1',
    '正在进行': 's2', '正在進行': 's2',
    '待驗收': 's3', '待验收': 's3',
    '待討論確認': 's4', '待讨论确认': 's4',
    '等待部署': 's5',
    '已完成': 's6', '完成': 's6',
    '不做了': 's7',
  };
  return m[s] || 's1';
}

// ── D1 insert helper: registry-aware coercion + ≤80 bound params/statement ──
const MAX_PARAMS = 80;

async function insertRows(env: Env, table: string, rows: Record<string, unknown>[], workspaceId: string): Promise<void> {
  if (rows.length === 0) return;
  const meta = TABLES[table];
  if (!meta) throw new Error(`Unknown table: ${table}`);
  assertIdent(table);

  const prepared = rows.map((r) => {
    const row: Record<string, unknown> = { ...r };
    row.workspace_id = workspaceId; // tenancy: forced on every row, never caller-supplied
    if (meta.autoId && (row.id === undefined || row.id === null)) row.id = crypto.randomUUID();
    for (const col of meta.autoNowCols || []) {
      if (row[col] === undefined) row[col] = nowIso();
    }
    return row;
  });

  const cols = Array.from(new Set(prepared.flatMap((r) => Object.keys(r))));
  for (const col of cols) assertIdent(col);

  const rowsPerStmt = Math.max(1, Math.floor(MAX_PARAMS / cols.length));
  const stmts: D1PreparedStatement[] = [];
  for (let i = 0; i < prepared.length; i += rowsPerStmt) {
    const chunk = prepared.slice(i, i + rowsPerStmt);
    const placeholders = chunk.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ');
    const sql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES ${placeholders}`;
    const params = chunk.flatMap((r) => cols.map((col) => valueToDb(col, r[col], meta)));
    stmts.push(env.DB.prepare(sql).bind(...params));
  }
  if (stmts.length === 1) {
    await stmts[0]!.run();
  } else {
    await env.DB.batch(stmts);
  }
}

// Row shapes (type aliases — object literals stay assignable to Record<string, unknown>)
type NewMemberRow = {
  id: string; name: string; avatar: string; role: string;
  email: string; color: string; job_title: string; is_active: boolean;
};

type TaskRow = {
  id: string; task_key: string; project_id: string; title: string;
  status_id: string; priority: string; creator_id: string;
  assignee_id: string | null; reviewer_id: string | null;
  due_date: string | null; started_at: string | null; completed_at: string | null;
  sort_order: number; created_at: string; comment_count: number;
  sprint_id: string | null; department: string | null;
};

type CommentRow = { id: string; task_id: string; user_id: string; content: string; created_at: string };
type SpecRow = { id: string; task_id: string; background: string; requirement: string; notes: string };

// Destructive clear — original deletion order (children before parents)
const CLEAR_TABLES = [
  'comments', 'task_checks', 'task_todos', 'task_specs', 'task_deployments',
  'task_attachments', 'status_logs', 'notifications', 'tasks', 'sprints',
];

// ── Handler (requireMember middleware already applied in index.ts) ──
export const handleImportJira = async (c: Context<AppContext>) => {
  const env = c.env;
  try {
    // Tenancy scope: every read/write below (license gate, wipe, inserts,
    // updates) is confined to the caller's workspace.
    const ws = c.get('auth').member.workspaceId;
    const ws8 = ws.slice(0, 8);
    // Legacy hardcoded project ids (p1..p12) are remapped per tenant: non-default
    // workspaces get `<ws8>-p1..` so tenants can never collide with each other
    // or the demo (projects.id is a global PK).
    const scopedProjectId = (pid: string) => (ws === DEFAULT_WORKSPACE ? pid : `${ws8}-${pid}`);
    // Same per-tenant remap for every other CSV-derived id this import
    // generates (member u{n}, comment c{n}, spec ts{n}, task id = Jira key,
    // status s1..s7): all of these are GLOBAL PKs, so non-default workspaces
    // get the <ws8>- prefix — cross-tenant collisions become impossible and
    // status ids line up with the provisioned <ws8>-s1..s7 rows.
    const scopedId = (id: string) => (ws === DEFAULT_WORKSPACE ? id : `${ws8}-${id}`);

    // Tier behavior (contract C2): non-professional callers get a SAFE DRY-RUN
    // (parse + stats, ZERO writes); professional callers get the real,
    // destructive import. isPro is resolved up front but only *enforced* after
    // the CSV is fully parsed into memory — the branch happens right before the
    // first DELETE, so a non-pro caller never touches D1.
    const isPro = await checkProfessional(env, ws);

    const csvText = await c.req.text();
    console.log('CSV length:', csvText.length);

    const rows = parseCSV(csvText);
    console.log('Parsed rows:', rows.length);

    if (rows.length < 2) {
      return c.json({ error: 'No data rows' }, 400);
    }

    const headers = rows[0]!;

    // Find column index by header name
    const col = (name: string) => headers.findIndex((h) => h.trim() === name);

    // Find ALL indices for a repeated column name
    const colAll = (name: string) => {
      const indices: number[] = [];
      headers.forEach((h, i) => { if (h.trim() === name) indices.push(i); });
      return indices;
    };

    // Sprint columns may be exported as English (Sprint) or Chinese (冲刺) and can repeat.
    const sprintIndices = Array.from(new Set([
      ...colAll('Sprint'),
      ...colAll('冲刺'),
    ]));

    const extractSprintName = (raw: string): string | null => {
      const s = (raw || '').trim();
      if (!s) return null;

      // Typical Jira export format contains: name=202603W1
      const matches = Array.from(s.matchAll(/name=([^,\]]+)/g));
      if (matches.length > 0) {
        const last = matches[matches.length - 1];
        if (last && last[1]) return String(last[1]).trim();
      }

      // JSON-ish payloads
      const jsonMatch = s.match(/"name"\s*:\s*"([^"]+)"/);
      if (jsonMatch && jsonMatch[1]) return jsonMatch[1].trim();

      // Plain sprint name fallback
      if (s.length <= 120 && !/com\.atlassian\.|\bid=\d+\b/i.test(s)) return s;

      return null;
    };

    const getSprintNameFromRow = (row: string[]): string => {
      if (sprintIndices.length === 0) return '';
      // Prefer the last non-empty sprint cell (often the most recent)
      for (let j = sprintIndices.length - 1; j >= 0; j--) {
        const idx = sprintIndices[j]!;
        const name = extractSprintName(row[idx] || '');
        if (name) return name;
      }
      return '';
    };

    const iTitle = col('摘要');
    const iKey = col('事务密钥');
    const iStatus = col('状态');
    const iProjKey = col('项目键');
    const iProjName = col('项目名称');
    const iPriority = col('优先级');
    const iAssignee = col('经办人');
    const iAssigneeId = col('经办人 ID');
    const iReporter = col('报告人');
    const iReporterId = col('报告人 ID');
    const iCreator = col('创建者');
    const iCreatorId = col('创建者 ID');
    const iCreated = col('已创建');
    const iResolved = col('已解决');
    const iDueDate = col('截止日期');
    const iStartDate = col('自定义字段 (Start date)');
    const iDescription = col('描述');
    const commentIndices = colAll('评论');

    console.log('Column indices:', {
      iTitle, iKey, iStatus, iProjKey, iPriority, iAssignee, iReporter, iCreated,
      sprintColumns: sprintIndices.length,
      commentColumns: commentIndices.length,
    });

    // Build jira account ID → name mapping from CSV data
    const jiraIdToName: Record<string, string> = {};
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]!;
      const assignee = row[iAssignee]?.trim();
      const assigneeId = row[iAssigneeId]?.trim();
      const reporter = row[iReporter]?.trim();
      const reporterId = row[iReporterId]?.trim();
      const creator = row[iCreator]?.trim();
      const creatorId = row[iCreatorId]?.trim();
      if (assignee && assigneeId) jiraIdToName[assigneeId] = assignee;
      if (reporter && reporterId) jiraIdToName[reporterId] = reporter;
      if (creator && creatorId) jiraIdToName[creatorId] = creator;
    }

    // Create missing members. Existing members of this workspace are reused
    // by exact name; everyone else becomes a new member (re-imports must not
    // recycle already-taken uN ids).
    const allNames = new Set(Object.values(jiraIdToName));
    const existingMembersRes = await env.DB
      .prepare('SELECT id, name FROM members WHERE workspace_id = ?')
      .bind(ws)
      .all<{ id: string; name: string }>();
    const existingMembers = existingMembersRes.results || [];
    const memberMap: Record<string, string> = {};
    let memberCounter = 10;
    for (const m of existingMembers) {
      if (!memberMap[m.name]) memberMap[m.name] = m.id;
      const um = /^(?:[0-9a-f]{8}-)?u(\d+)$/.exec(m.id); // tolerate the <ws8>- prefix
      if (um) memberCounter = Math.max(memberCounter, parseInt(um[1]!, 10) + 1);
    }
    const newMembers: NewMemberRow[] = [];

    for (const name of allNames) {
      if (!memberMap[name]) {
        const id = scopedId(`u${memberCounter++}`);
        memberMap[name] = id;
        newMembers.push({
          id, name, avatar: name[0]?.toUpperCase() || '?',
          // email must be unique per member: members has a UNIQUE (nocase)
          // index on email, so two '' rows would fail the whole insert batch.
          role: 'member', email: `${id}@import.invalid`, color: '#6B778C', job_title: '',
          is_active: true,
        });
      }
    }

    // Fallback identity for rows with no resolvable reporter/creator: the
    // importing admin (the legacy hardcoded 'u1' doesn't exist on fresh installs).
    const authInfo = c.get('auth');
    const fallbackMemberId = authInfo?.member?.id || 'u1';

    // Build jiraId → memberId mapping
    const jiraIdToMemberId: Record<string, string> = {};
    for (const [jiraId, name] of Object.entries(jiraIdToName)) {
      jiraIdToMemberId[jiraId] = memberMap[name] || fallbackMemberId;
    }

    // ── Build sprint mapping (ids generated here so tasks can reference them;
    //    NO DB write yet — the actual insert happens only on the pro path). ──
    const sprintNames = new Set<string>();
    const sprintMap = new Map<string, string>(); // jira sprint name → db sprint id
    for (let r = 1; r < rows.length; r++) {
      const sprintName = getSprintNameFromRow(rows[r]!);
      if (sprintName) sprintNames.add(sprintName);
    }
    for (const sprintName of sprintNames) {
      sprintMap.set(sprintName, crypto.randomUUID());
    }

    // ── Projects: one LIVO project per Jira project key. A project of this
    //    workspace with the same key is reused (projects are not cleared, so a
    //    re-import lands in the same place); any other key becomes a new
    //    project named after the Jira project, created on the real-import path
    //    below. ──
    const existingProjectsRes = await env.DB
      .prepare('SELECT id, key FROM projects WHERE workspace_id = ?')
      .bind(ws)
      .all<{ id: string; key: string }>();
    const projectIdByKey = new Map<string, string>();
    for (const p of existingProjectsRes.results || []) {
      const k = (p.key || '').trim().toUpperCase();
      if (k && !projectIdByKey.has(k)) projectIdByKey.set(k, p.id);
    }
    const newProjects = new Map<string, { id: string; name: string; key: string }>();
    const projectIdFor = (rawKey: string, rawName: string): string => {
      const key = rawKey.trim().toUpperCase();
      const known = projectIdByKey.get(key);
      if (known) return known;
      const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
      const id = scopedProjectId(`jira-${slug}`);
      projectIdByKey.set(key, id);
      newProjects.set(key, { id, name: rawName.trim() || key, key });
      return id;
    };

    // ── Parse tasks + comments + specs into memory (still NO DB write) ──
    const tasks: TaskRow[] = [];
    const comments: CommentRow[] = [];
    const taskSpecs: SpecRow[] = [];
    let commentId = 1;
    let specId = 1;
    const seenTaskKeys = new Set<string>();

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r]!;
      const taskKey = row[iKey]?.trim();
      if (!taskKey || seenTaskKeys.has(taskKey)) continue;
      seenTaskKeys.add(taskKey);

      const projectKey = row[iProjKey]?.trim();
      if (!projectKey) continue;

      const title = row[iTitle]?.trim() || '';
      const statusStr = row[iStatus]?.trim() || '待办';
      const priorityStr = row[iPriority]?.trim() || 'Medium';
      const assigneeName = row[iAssignee]?.trim() || '';
      const reporterName = row[iReporter]?.trim() || '';
      const creatorName = row[iCreator]?.trim() || '';
      const createdStr = row[iCreated]?.trim() || '';
      const resolvedStr = row[iResolved]?.trim() || '';
      const dueDateStr = row[iDueDate]?.trim() || '';
      const startDateStr = iStartDate >= 0 ? (row[iStartDate]?.trim() || '') : '';
      const sprintName = getSprintNameFromRow(row);

      const projectId = projectIdFor(projectKey, iProjName >= 0 ? row[iProjName] || '' : '');
      const statusId = scopedId(mapStatusId(statusStr));
      const priority = mapPriority(priorityStr);
      const sprintId = sprintName ? (sprintMap.get(sprintName) || null) : null;

      // Map assignee (经办人=指派人), reporter (报告人=验收人&开卡人)
      const assigneeId = assigneeName ? (memberMap[assigneeName] || null) : null;
      const reviewerId = reporterName ? (memberMap[reporterName] || null) : null;
      const creatorId = reporterName
        ? (memberMap[reporterName] || (creatorName ? memberMap[creatorName] : null) || fallbackMemberId)
        : (creatorName ? memberMap[creatorName] : null) || fallbackMemberId;

      const createdAt = parseDateOnly(createdStr) || dateOnlyPart(new Date().toISOString());
      const completedAt = parseChineseDateTime(resolvedStr);
      const dueDate = parseDateOnly(dueDateStr);
      const startedAt = startDateStr
        ? (/^\d{4}/.test(startDateStr) ? dateOnlyPart(startDateStr) : parseDateOnly(startDateStr))
        : null;

      // Extract comments from comment columns
      let taskCommentCount = 0;
      for (const ci of commentIndices) {
        const cell = row[ci]?.trim();
        if (!cell) continue;

        // Parse comment: "date;jira_id;content"
        const firstSemi = cell.indexOf(';');
        if (firstSemi < 0) continue;
        const secondSemi = cell.indexOf(';', firstSemi + 1);
        if (secondSemi < 0) continue;

        const commentDateStr = cell.substring(0, firstSemi).trim();
        const commentJiraId = cell.substring(firstSemi + 1, secondSemi).trim();
        const commentContent = cell.substring(secondSemi + 1).trim();

        if (!commentContent) continue;

        const commentDate = parseChineseDateTime(commentDateStr);
        const commentUserId = jiraIdToMemberId[commentJiraId] || fallbackMemberId;

        comments.push({
          id: scopedId(`c${String(commentId++).padStart(5, '0')}`),
          task_id: scopedId(taskKey),
          user_id: commentUserId,
          content: textToHtml(commentContent, jiraIdToName, memberMap),
          created_at: commentDate || createdAt,
        });
        taskCommentCount++;
      }

      // Extract description → task_specs
      const description = iDescription >= 0 ? (row[iDescription]?.trim() || '') : '';
      if (description) {
        taskSpecs.push({
          id: scopedId(`ts${String(specId++).padStart(5, '0')}`),
          task_id: scopedId(taskKey),
          background: '',
          requirement: textToHtml(description, jiraIdToName, memberMap),
          notes: '',
        });
      }

      // Department is back-filled from members.job_title after insert.
      const department: string | null = null;

      tasks.push({
        id: scopedId(taskKey), // display key stays raw; the id must be globally unique
        task_key: taskKey,
        project_id: projectId,
        title,
        status_id: statusId,
        priority,
        creator_id: creatorId,
        assignee_id: assigneeId,
        reviewer_id: reviewerId,
        due_date: dueDate,
        started_at: startedAt,
        completed_at: completedAt ? dateOnlyPart(completedAt) : null,
        sort_order: r,
        created_at: createdAt,
        comment_count: taskCommentCount,
        sprint_id: sprintId,
        department,
      });
    }

    // ── Stats (identical shape for both dry-run and real import) ──
    const stats = {
      totalRows: rows.length - 1,
      tasksParsed: tasks.length,
      commentsParsed: comments.length,
      specsParsed: taskSpecs.length,
      sprintsParsed: sprintMap.size,
      newMembers: newMembers.map((m) => m.name),
      newProjects: Array.from(newProjects.values()).map((p) => p.name),
    };

    // ── Beta member cap (same rule as manage-member create): the import
    //    would otherwise mint an active member row per distinct CSV name,
    //    blowing past workspaces.member_limit and then wedging 成員管理. ──
    if (ws !== DEFAULT_WORKSPACE && newMembers.length > 0) {
      const quota = await env.DB
        .prepare(
          `SELECT w.member_limit AS lim,
                  (SELECT COUNT(*) FROM members m WHERE m.workspace_id = w.id AND m.is_active = 1) AS used
           FROM workspaces w WHERE w.id = ?1`
        )
        .bind(ws)
        .first<{ lim: number; used: number }>();
      if (quota && quota.used + newMembers.length > quota.lim) {
        return c.json(
          {
            error: `匯入將新增 ${newMembers.length} 位成員，超過 Beta 成員上限（${quota.lim} 人）。請先精簡 CSV 中的人員，或聯繫 service@livo-tw.com`,
            stats,
          },
          403
        );
      }
    }

    // ── Tier branch (contract C2): non-pro → SAFE DRY-RUN, nothing written. ──
    if (!isPro) {
      console.log('[import-jira] dry-run (non-professional):', JSON.stringify(stats));
      return c.json({ success: true, dryRun: true, stats });
    }

    // ═══ Professional path: the real, DESTRUCTIVE import (writes begin here) ═══

    // ── Clear existing data (atomic batch, original table order) — only the
    //    caller's workspace; other tenants' rows are untouchable. ──
    console.log('Clearing existing data...');
    await env.DB.batch(
      CLEAR_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${assertIdent(t)} WHERE workspace_id = ?`).bind(ws))
    );

    // ── Create the projects this CSV introduces. Without these rows the
    //    tasks.project_id FK rejects every task insert. ──
    try {
      if (newProjects.size > 0) {
        let lineId = (
          await env.DB.prepare('SELECT id FROM product_lines WHERE workspace_id = ? ORDER BY sort_order LIMIT 1')
            .bind(ws)
            .first<{ id: string }>()
        )?.id;
        if (!lineId) {
          // Non-default workspaces get a ws-prefixed id (product_lines.id is a
          // global PK — a shared id would collide across tenants).
          lineId = ws === DEFAULT_WORKSPACE ? 'pl-import' : `${ws8}-pl-import`;
          await env.DB.prepare("INSERT OR IGNORE INTO product_lines (id, name, workspace_id) VALUES (?, '匯入', ?)")
            .bind(lineId, ws)
            .run();
        }
        await env.DB.batch(
          Array.from(newProjects.values()).map((p) =>
            env.DB
              .prepare('INSERT OR IGNORE INTO projects (id, line_id, name, key, workspace_id) VALUES (?, ?, ?, ?, ?)')
              .bind(p.id, lineId, p.name, p.key, ws)
          )
        );
      }
    } catch (error) {
      console.error('Ensure projects error:', error);
    }

    // ── Insert new members ──
    if (newMembers.length > 0) {
      console.log('Creating new members:', newMembers.map((m) => m.name));
      try {
        await insertRows(env, 'members', newMembers, ws);
      } catch (error) {
        console.error('Insert members error:', error);
      }
    }

    // ── Insert sprints. On failure, drop the mapping AND detach the tasks that
    //    referenced the now-missing sprints (parity with the original, which
    //    built tasks only after a successful sprint insert). ──
    if (sprintMap.size > 0) {
      const sprintRows = Array.from(sprintMap.entries()).map(([name, id]) => ({
        id,
        name,
        is_active: false,
        completed_at: nowIso(),
        completed_count: 0,
        pending_count: 0,
      }));
      try {
        await insertRows(env, 'sprints', sprintRows, ws);
      } catch (error) {
        console.error('Insert sprint error:', error);
        sprintMap.clear(); // failed sprints must not be referenced by tasks
        for (const t of tasks) t.sprint_id = null;
      }
    }
    console.log('Created sprints:', Array.from(sprintMap.keys()));

    console.log(`Inserting ${tasks.length} tasks, ${comments.length} comments, ${taskSpecs.length} specs`);

    // Insert tasks in slices of 50 (each slice atomic; failures logged, import
    // continues — original behavior). Inserted counts are tracked so the
    // response stats reflect what actually landed in D1, not just what parsed.
    let tasksInserted = 0;
    for (let i = 0; i < tasks.length; i += 50) {
      const batch = tasks.slice(i, i + 50);
      try {
        await insertRows(env, 'tasks', batch, ws);
        tasksInserted += batch.length;
      } catch (error) {
        console.error(`Insert tasks batch ${i} error:`, error, 'First task:', JSON.stringify(batch[0]));
      }
    }

    // Insert comments in slices of 100
    let commentsInserted = 0;
    for (let i = 0; i < comments.length; i += 100) {
      const batch = comments.slice(i, i + 100);
      try {
        await insertRows(env, 'comments', batch, ws);
        commentsInserted += batch.length;
      } catch (error) {
        console.error(`Insert comments batch ${i} error:`, error);
      }
    }

    // Insert task_specs in slices of 50
    let specsInserted = 0;
    for (let i = 0; i < taskSpecs.length; i += 50) {
      const batch = taskSpecs.slice(i, i + 50);
      try {
        await insertRows(env, 'task_specs', batch, ws);
        specsInserted += batch.length;
      } catch (error) {
        console.error(`Insert specs batch ${i} error:`, error);
      }
    }

    // ── Post-insert: set department based on member job_titles ──
    try {
      const memberRes = await env.DB
        .prepare('SELECT id, name, job_title FROM members WHERE workspace_id = ?')
        .bind(ws)
        .all<{ id: string; name: string; job_title: string | null }>();
      const memberRows = memberRes.results || [];
      const getDept = (member: { name: string; job_title: string }): string | null => {
        const jt = member.job_title.toLowerCase();
        if (/\b(ceo|cto|coo|cfo|vp|director)\b/.test(jt) || /總監|总监/.test(jt)) return 'MGR';
        if (jt.includes('pm') || jt.includes('product') || jt.includes('產品') || jt.includes('产品')) return 'PM';
        if (jt.includes('sre') || jt.includes('devops') || jt.includes('infrastructure')) return 'SRE';
        if (jt.includes('be') || jt.includes('backend') || jt.includes('後端') || jt.includes('后端')) return 'BE';
        if (jt.includes('fe') || jt.includes('frontend') || jt.includes('前端')) return 'FE';
        if (jt.includes('qa') || jt.includes('test') || jt.includes('測試') || jt.includes('测试')) return 'QA';
        return null;
      };
      const memberDeptMap = new Map<string, string>();
      for (const m of memberRows) {
        const dept = getDept({ name: m.name, job_title: m.job_title || '' });
        if (dept) memberDeptMap.set(m.id, dept);
      }
      // Batch update tasks by assignee department
      const deptStmts = Array.from(memberDeptMap.entries()).map(([memberId, dept]) =>
        env.DB
          .prepare('UPDATE tasks SET department = ? WHERE assignee_id = ? AND department IS NULL AND workspace_id = ?')
          .bind(dept, memberId, ws)
      );
      if (deptStmts.length > 0) await env.DB.batch(deptStmts);
      console.log(`Set departments for ${memberDeptMap.size} members`);
    } catch (error) {
      console.error('Set departments error:', error);
    }

    // Update sprint dates and counts from task data
    // started_at = earliest created_at of tasks in this sprint
    // completed_at = latest completed_at of tasks in this sprint
    try {
      const sprintStmts: D1PreparedStatement[] = [];
      for (const sprintId of sprintMap.values()) {
        const sprintTasks = tasks.filter((t) => t.sprint_id === sprintId);
        const completedCount = sprintTasks.filter((t) => ['s6', 's7'].includes(t.status_id)).length;
        const pendingCount = sprintTasks.length - completedCount;

        // started_at: earliest created_at among tasks in this sprint
        const createdDates = sprintTasks
          .map((t) => new Date(t.created_at).getTime())
          .filter((ts) => !isNaN(ts));
        const minCreated = createdDates.length > 0 ? new Date(Math.min(...createdDates)) : null;

        // completed_at: latest completed_at among tasks in this sprint
        const completedDates = sprintTasks
          .filter((t) => t.completed_at)
          .map((t) => new Date(t.completed_at as string).getTime())
          .filter((ts) => !isNaN(ts));
        const maxCompleted = completedDates.length > 0 ? new Date(Math.max(...completedDates)) : null;

        const sets = ['completed_count = ?', 'pending_count = ?'];
        const params: unknown[] = [completedCount, pendingCount];
        if (maxCompleted) { sets.push('completed_at = ?'); params.push(maxCompleted.toISOString()); }
        if (minCreated) { sets.push('started_at = ?'); params.push(minCreated.toISOString()); }
        params.push(sprintId, ws);
        sprintStmts.push(
          env.DB.prepare(`UPDATE sprints SET ${sets.join(', ')} WHERE id = ? AND workspace_id = ?`).bind(...params)
        );
      }
      if (sprintStmts.length > 0) await env.DB.batch(sprintStmts);
    } catch (error) {
      console.error('Update sprint stats error:', error);
    }

    // ── Create active sprint and assign uncompleted tasks ──
    try {
      const now = new Date();
      const y = now.getFullYear();
      const mo = String(now.getMonth() + 1).padStart(2, '0');
      const activeSprintName = `${y}${mo}W1`;
      const activeSprintId = crypto.randomUUID();

      await insertRows(env, 'sprints', [{ id: activeSprintId, name: activeSprintName, is_active: true }], ws);

      // Move all uncompleted tasks to the active sprint
      const uncompletedTaskIds = tasks
        .filter((t) => !['s6', 's7'].includes(t.status_id))
        .map((t) => t.id);

      if (uncompletedTaskIds.length > 0) {
        const idsPerStmt = MAX_PARAMS - 2; // 2 params used by sprint_id + workspace_id
        const moveStmts: D1PreparedStatement[] = [];
        for (let i = 0; i < uncompletedTaskIds.length; i += idsPerStmt) {
          const chunk = uncompletedTaskIds.slice(i, i + idsPerStmt);
          const placeholders = chunk.map(() => '?').join(', ');
          moveStmts.push(
            env.DB
              .prepare(`UPDATE tasks SET sprint_id = ? WHERE id IN (${placeholders}) AND workspace_id = ?`)
              .bind(activeSprintId, ...chunk, ws)
          );
        }
        await env.DB.batch(moveStmts);
      }
      console.log(`Created active sprint "${activeSprintName}" with ${uncompletedTaskIds.length} uncompleted tasks`);
    } catch (error) {
      console.error('Create active sprint error:', error);
    }

    // Synthetic refresh pings (DESIGN decision: no per-row flood; sprints/projects
    // config-table pings trigger refreshTasks on other connected clients).
    // (cast: hono's minimal ExecutionContext type lacks workers-types v5 extras)
    const execCtx = c.executionCtx as ExecutionContext;
    const pings: { table: string; eventType: 'UPDATE'; new: null; old: null }[] = [
      { table: 'sprints', eventType: 'UPDATE', new: null, old: null },
      { table: 'projects', eventType: 'UPDATE', new: null, old: null },
    ];
    // Import-created members must propagate to other connected clients too.
    if (newMembers.length > 0) {
      pings.push({ table: 'members', eventType: 'UPDATE', new: null, old: null });
    }
    notifyChanges(env, execCtx, pings, ws);

    return c.json({
      success: true,
      dryRun: false,
      stats: {
        ...stats,
        // Actual insert results (sprintMap is cleared when its insert fails,
        // so its size is the real created count).
        tasksInserted,
        commentsInserted,
        specsInserted,
        sprintsCreated: sprintMap.size,
      },
    });
  } catch (err) {
    console.error('Import error:', err);
    return c.json({ error: String(err) }, 500);
  }
};
