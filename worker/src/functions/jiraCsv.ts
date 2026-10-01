// Jira CSV parsing shared by the Jira importers (and the email rules
// manage-member uses for 「啟用帳號」).
//
// This file is copied verbatim (the copies must stay byte-identical; a unit
// test checks it):
//   worker/src/functions/jiraCsv.ts                    ← edit this one
//   docker/volumes/functions/import-jira/jiraCsv.ts
//   docker/volumes/functions/manage-member/jiraCsv.ts
//   supabase/functions/import-jira/jiraCsv.ts
//   supabase/functions/manage-member/jiraCsv.ts
// After editing run `npm run sync:shared` (scripts/sync-shared-code.mjs).
//
// Keep it dependency-free and runtime-neutral (Cloudflare Workers + Deno):
// no imports, no Node or DOM APIs.
//
// What it does: header aliases (English + Simplified Chinese exports),
// status / priority / date mapping, people collection and the plan for which
// CSV person becomes which LIVO member (existing, activated, new account or
// name-only). Database access stays in the importers.

// ─── CSV ────────────────────────────────────────────────────────────────

/** Minimal RFC-4180 parser: quoted fields may contain commas, quotes ("") and newlines. */
export function parseCSV(text: string): string[][] {
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

// ─── Text normalization ─────────────────────────────────────────────────

/** NFKC (full-width → half-width, ideographic space → space), trim, collapse inner whitespace. */
export function normalizeText(s: string | null | undefined): string {
  return (s || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/** Case-insensitive comparison key for names, headers and enum values. */
export function matchKey(s: string | null | undefined): string {
  return normalizeText(s).replace(/[‘’ʼ]/g, "'").toLowerCase();
}

/** How a person's name is displayed and stored (normalized, original case). */
export function cleanPersonName(s: string | null | undefined): string {
  return normalizeText(s);
}

/**
 * Key that identifies one person across the CSV, the member list and the
 * email list: trimmed, case-insensitive, full-width = half-width, and a space
 * between two CJK characters ignored (「柯 雨辰」 = 「柯雨辰」).
 */
export function personKey(s: string | null | undefined): string {
  return matchKey(s).replace(/(?<=[\u3400-\u9fff\uf900-\ufaff]) (?=[\u3400-\u9fff\uf900-\ufaff])/g, '');
}

// ─── Header aliases ─────────────────────────────────────────────────────
// The ONE place that lists the header names each field accepts. Matching
// ignores surrounding whitespace, case and full-width/half-width differences.
//   English: Jira Cloud's standard export headers.
//   简体中文: taken from a real Simplified Chinese Jira export.
//   繁體中文: none — a Traditional Chinese Jira UI exports no Traditional
//            Chinese headers (checked against a real export), so there is
//            nothing to add. If that changes, add the names here.

export const FIELD_ALIASES = {
  title: ['Summary', '摘要'],
  key: ['Issue key', '事务密钥'],
  status: ['Status', '状态'],
  statusCategory: ['Status Category', '状态类别'],
  projectKey: ['Project key', '项目键'],
  projectName: ['Project name', '项目名称'],
  priority: ['Priority', '优先级'],
  assignee: ['Assignee', '经办人'],
  assigneeId: ['Assignee Id', '经办人 ID'],
  reporter: ['Reporter', '报告人'],
  reporterId: ['Reporter Id', '报告人 ID'],
  creator: ['Creator', '创建者'],
  creatorId: ['Creator Id', '创建者 ID'],
  created: ['Created', '已创建'],
  resolved: ['Resolved', '已解决'],
  dueDate: ['Due date', '截止日期'],
  startDate: ['Custom field (Start date)', '自定义字段 (Start date)'],
  description: ['Description', '描述'],
  issueId: ['Issue id', '事务ID'],
  issueType: ['Issue Type', '事务类型'],
  // Jira Cloud puts the parent's numeric issue id in "Parent"; the parent's
  // key has its own column only in the Simplified Chinese export we have seen
  // (Atlassian's English export does not include it, JRACLOUD-84530).
  parent: ['Parent', '父项'],
  parentKey: ['父项关键字'],
  // These columns repeat (one column per comment / sprint / attachment).
  comment: ['Comment', '评论'],
  sprint: ['Sprint', '冲刺'],
  attachment: ['Attachment', '附件'],
} as const;

export type JiraField = keyof typeof FIELD_ALIASES;

/** Without these the import cannot produce a single task. */
export const REQUIRED_FIELDS: readonly JiraField[] = ['title', 'key'];

export interface MissingColumn {
  field: JiraField;
  /** Header names that would have been accepted for this field. */
  accepted: string[];
}

export interface JiraColumns {
  /** First column of each field, when present. */
  index: Partial<Record<JiraField, number>>;
  /** Every column of each field, in order (comment / sprint repeat). */
  all: Partial<Record<JiraField, number[]>>;
  /** Required fields with no matching column. */
  missing: MissingColumn[];
  /** The CSV's own header names (non-empty, de-duplicated, in order). */
  detected: string[];
}

export function resolveColumns(headers: string[]): JiraColumns {
  const byKey = new Map<string, JiraField>();
  for (const field of Object.keys(FIELD_ALIASES) as JiraField[]) {
    for (const alias of FIELD_ALIASES[field]) byKey.set(matchKey(alias), field);
  }
  const index: Partial<Record<JiraField, number>> = {};
  const all: Partial<Record<JiraField, number[]>> = {};
  const detected: string[] = [];
  const seen = new Set<string>();
  headers.forEach((raw, i) => {
    const shown = normalizeText(raw);
    if (shown && !seen.has(shown)) {
      seen.add(shown);
      detected.push(shown);
    }
    const field = byKey.get(matchKey(raw));
    if (!field) return;
    if (index[field] === undefined) index[field] = i;
    (all[field] = all[field] || []).push(i);
  });
  const missing = REQUIRED_FIELDS.filter((f) => index[f] === undefined).map((field) => ({
    field,
    accepted: [...FIELD_ALIASES[field]],
  }));
  return { index, all, missing, detected };
}

// ─── Status ─────────────────────────────────────────────────────────────
// LIVO's seven default statuses (worker/seed.sql, worker/src/provision.ts,
// release-template/first-run.sql — same ids everywhere; cloud workspaces add
// a `<ws8>-` prefix, which the importers apply):
//   s1 待辦 · s2 正在進行 · s3 待驗收 · s4 待討論確認 · s5 等待部署 · s6 完成 · s7 不做了
// s6 and s7 are the done statuses.

export const DONE_STATUS_IDS: readonly string[] = ['s6', 's7'];

// Order: an explicit status-name mapping first (1, then 2), the status
// category only when the name means nothing to us (3) — e.g. 不做了 sits in
// the 待办 / To Do category in Jira but belongs in s7.
// 1) LIVO's own status names (and the mapping earlier versions hard-coded):
//    always win, so existing imports keep landing where they did.
const LIVO_STATUS_NAMES: Record<string, string> = {
  '待办': 's1', '待辦': 's1',
  '正在进行': 's2', '正在進行': 's2',
  '待驗收': 's3', '待验收': 's3',
  '待討論確認': 's4', '待讨论确认': 's4',
  '等待部署': 's5', '等待部屬': 's5', '等待部属': 's5', // 部屬: a common misspelling seen in real exports
  '已完成': 's6', '完成': 's6',
  '不做了': 's7',
};

// 3) Jira's "Status Category" column (To Do / In Progress / Done).
const STATUS_CATEGORY_ALIASES: Record<string, string[]> = {
  s1: ['To Do', '待办', '待辦'],
  s2: ['In Progress', '正在进行', '正在進行', '进行中', '進行中', '处理中', '處理中'],
  s6: ['Done', '完成', '已完成'],
};

// 2) Common Jira status names (English, Simplified, Traditional).
const COMMON_STATUS_ALIASES: Record<string, string[]> = {
  s1: [
    'To Do', 'Todo', 'Open', 'Backlog', 'New', 'Reopened', 'Selected for Development',
    '待处理', '待處理', '新建', '重新打开', '重新開啟',
  ],
  s2: [
    'In Progress', 'Doing', 'In Development', 'In Review', 'Review', 'In QA', 'Testing',
    '进行中', '進行中', '处理中', '處理中', '开发中', '開發中', '测试中', '測試中',
  ],
  s6: [
    'Done', 'Closed', 'Resolved', 'Complete', 'Completed',
    '已解决', '已解決', '已关闭', '已關閉',
  ],
  s7: [
    "Won't Do", "Won't Fix", 'Cancelled', 'Canceled', 'Rejected', 'Declined',
    '已取消', '取消', '不处理', '不處理',
  ],
};

function aliasLookup(table: Record<string, string[]>): Map<string, string> {
  const m = new Map<string, string>();
  for (const id of Object.keys(table)) {
    for (const alias of table[id] || []) m.set(matchKey(alias), id);
  }
  return m;
}

const LIVO_STATUS_LOOKUP = new Map(Object.entries(LIVO_STATUS_NAMES).map(([k, v]) => [matchKey(k), v]));
const CATEGORY_LOOKUP = aliasLookup(STATUS_CATEGORY_ALIASES);
const COMMON_STATUS_LOOKUP = aliasLookup(COMMON_STATUS_ALIASES);

/** How a Jira status reached its base id: a known name, the status category, or nothing (s1). */
export type StatusVia = 'alias' | 'category' | 'default';

/** Jira status (+ optional status category) → LIVO base status id (s1–s7, unprefixed) and how. */
export function mapStatusDetailed(
  status: string | null | undefined,
  category?: string | null,
): { baseId: string; via: StatusVia } {
  const s = matchKey(status);
  const byName = LIVO_STATUS_LOOKUP.get(s) || COMMON_STATUS_LOOKUP.get(s);
  if (byName) return { baseId: byName, via: 'alias' };
  const byCategory = CATEGORY_LOOKUP.get(matchKey(category));
  if (byCategory) return { baseId: byCategory, via: 'category' };
  return { baseId: 's1', via: 'default' };
}

/** Jira status (+ optional status category) → LIVO base status id (s1–s7, unprefixed). */
export function mapStatus(status: string | null | undefined, category?: string | null): string {
  return mapStatusDetailed(status, category).baseId;
}

// ─── Statuses of the workspace being imported into ──────────────────────
// A workspace can rename, delete and add statuses (狀態管理), so s1–s7 are
// only the defaults. The importer resolves every Jira status against the
// workspace's own list:
//   1) a workspace status with the same name (case, full-/half-width and
//      Traditional/Simplified insensitive) — always wins;
//   2) the base id from mapStatusDetailed when that status still exists and
//      is still done / not done like the default;
//   3) otherwise a status of the same kind: to-do = the first column, in
//      progress = the auto-start status (else the next open column), done =
//      the first done status; with nothing of that kind, the first status.

export interface WorkspaceStatus {
  id: string;
  name: string;
  sort_order?: number | null;
  is_done?: boolean | number | null;
  auto_start?: boolean | number | null;
}

export interface StatusMappingRow {
  jiraStatus: string;
  jiraCategory: string;
  issueCount: number;
  statusId: string;
  statusName: string;
  /** 'name' = same name in the workspace; 'alias' / 'category' / 'default' = rule 2 or 3. */
  via: 'name' | StatusVia;
  /** Rule 3 had to stand in because the default status is gone or changed. */
  substituted: boolean;
}

export type StatusPlan =
  | { ok: false; error: 'no_statuses' }
  | {
      ok: true;
      /** Workspace status id for each issue key. */
      statusIdOf: (issueKey: string) => string;
      isDone: (statusId: string) => boolean;
      mapping: StatusMappingRow[];
    };

// Traditional → Simplified for the characters status names are made of, so
// 「待驗收」 matches 「待验收」. Not a converter, just enough for comparing.
const HANT_TO_HANS: Record<string, string> = Object.fromEntries(
  Array.from(
    '辦办進进驗验討讨論论確确認认處处關关閉闭開开啟启發发測测試试決决審审實实現现線线際际單单據据項项務务類类條条' +
    '號号為为與与對对應应會会議议復复歸归檔档廢废棄弃終终結结銷销舊旧準准備备釋释環环產产暫暂擱搁這这個个們们過过' +
    '還还選选擇择規规劃划計计設设佈布庫库檢检轉转換换給给讓让請请問问題题屬属賴赖錯错誤误緊紧長长場场動动態态標标' +
    '記记點点響响優优級级週周',
  ).reduce<[string, string][]>((pairs, ch, i, all) => (i % 2 === 0 ? [...pairs, [ch, all[i + 1]]] : pairs), []),
);

/** Comparison key for status names: matchKey + Traditional → Simplified + the 部屬 typo. */
export function statusNameKey(s: string | null | undefined): string {
  return Array.from(matchKey(s), (ch) => HANT_TO_HANS[ch] || ch)
    .join('')
    .replace(/部属/g, '部署');
}

const truthy = (v: boolean | number | null | undefined) => v === true || v === 1;
const BASE_IS_DONE = new Set(DONE_STATUS_IDS);
const BASE_KIND: Record<string, 'todo' | 'doing' | 'done'> = {
  s1: 'todo', s2: 'doing', s3: 'doing', s4: 'doing', s5: 'doing', s6: 'done', s7: 'done',
};

export function planStatuses(
  issues: { key: string; status: string; statusCategory: string }[],
  statuses: WorkspaceStatus[],
  options: { idPrefix?: string } = {},
): StatusPlan {
  if (statuses.length === 0) return { ok: false, error: 'no_statuses' };
  const prefix = options.idPrefix || '';
  const sorted = [...statuses].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((st) => [st.id, st]));
  const byName = new Map<string, WorkspaceStatus>();
  for (const st of sorted) {
    const k = statusNameKey(st.name);
    if (k && !byName.has(k)) byName.set(k, st); // names are not unique: the first column wins
  }
  const open = sorted.filter((st) => !truthy(st.is_done));
  const done = sorted.filter((st) => truthy(st.is_done));
  const todo = open.find((st) => !truthy(st.auto_start)) || open[0] || sorted[0];
  const doing = open.find((st) => truthy(st.auto_start)) || open.find((st) => st !== todo) || todo;
  const kindStatus = { todo, doing, done: done[0] || sorted[sorted.length - 1] };

  const rows = new Map<string, StatusMappingRow>();
  const idByIssue = new Map<string, string>();
  for (const issue of issues) {
    const rowKey = `${statusNameKey(issue.status)}\u0000${matchKey(issue.statusCategory)}`;
    let row = rows.get(rowKey);
    if (!row) {
      const named = issue.status ? byName.get(statusNameKey(issue.status)) : undefined;
      let target: WorkspaceStatus;
      let via: StatusMappingRow['via'];
      let substituted = false;
      if (named) {
        target = named;
        via = 'name';
      } else {
        const { baseId, via: baseVia } = mapStatusDetailed(issue.status, issue.statusCategory);
        via = baseVia;
        const dflt = byId.get(prefix + baseId);
        if (dflt && truthy(dflt.is_done) === BASE_IS_DONE.has(baseId)) target = dflt;
        else {
          target = kindStatus[BASE_KIND[baseId] || 'todo'];
          substituted = true;
        }
      }
      row = {
        jiraStatus: issue.status,
        jiraCategory: issue.statusCategory,
        issueCount: 0,
        statusId: target.id,
        statusName: target.name,
        via,
        substituted,
      };
      rows.set(rowKey, row);
    }
    row.issueCount++;
    idByIssue.set(issue.key, row.statusId);
  }
  const fallbackId = kindStatus.todo.id;
  return {
    ok: true,
    statusIdOf: (key) => idByIssue.get(key) || fallbackId,
    isDone: (id) => truthy(byId.get(id)?.is_done),
    mapping: Array.from(rows.values()).sort((a, b) => b.issueCount - a.issueCount),
  };
}

// ─── Priority ───────────────────────────────────────────────────────────
// Jira's current priorities, the classic scheme they replaced
// (Blocker…Trivial, same order) and Chinese names.

const PRIORITY_ALIASES: Record<string, string[]> = {
  highest: ['Highest', 'Blocker', '最高', '紧急', '緊急'],
  high: ['High', 'Critical', '高'],
  medium: ['Medium', 'Major', '中', '中等'],
  low: ['Low', 'Minor', '低'],
  lowest: ['Lowest', 'Trivial', '最低'],
};
const PRIORITY_LOOKUP = aliasLookup(PRIORITY_ALIASES);

export function mapPriority(p: string | null | undefined): string {
  return PRIORITY_LOOKUP.get(matchKey(p)) || 'medium';
}

// ─── Dates ──────────────────────────────────────────────────────────────
// Accepted:
//   15/Mar/24 10:30 AM      (English Jira; month names or abbreviations)
//   15/三月/24 10:30 上午    (Chinese Jira; also 15/3月/24)
//   2024-03-15, 2024-03-15T10:30:00.000+0800, 2024/03/15 10:30   (ISO-like)
// Jira writes times in the exporting user's time zone without saying which.
// Timestamps are converted to UTC with the IANA zone the importer passes
// (the admin's choice, Asia/Taipei by default); a value that carries its own
// offset uses that. Calendar dates (created / resolved / due / start, stored
// as YYYY-MM-DD) keep the date as written — that IS the local date.

/** Zone used when the caller does not say (LIVO's dates are Taiwan-local). */
export const DEFAULT_TIME_ZONE = 'Asia/Taipei';

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** A usable IANA zone name, or null. */
export function validTimeZone(tz: string | null | undefined): string | null {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

/** Minutes the zone is ahead of UTC at the given instant. */
function zoneOffsetMinutes(timeZone: string, utcMs: number): number {
  let fmt = zoneFormatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    zoneFormatters.set(timeZone, fmt);
  }
  const parts: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') parts[p.type] = parseInt(p.value, 10);
  }
  const wall = Date.UTC(parts.year || 0, (parts.month || 1) - 1, parts.day || 1, (parts.hour || 0) % 24, parts.minute || 0, parts.second || 0);
  return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / 60_000);
}

/** UTC instant of a wall-clock time in `timeZone` (DST gaps resolve forward). */
function zonedToUtcMs(wallMs: number, timeZone: string): number {
  const first = wallMs - zoneOffsetMinutes(timeZone, wallMs) * 60_000;
  const second = wallMs - zoneOffsetMinutes(timeZone, first) * 60_000;
  return second;
}

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10,
  dec: 11, december: 11,
  '一月': 0, '二月': 1, '三月': 2, '四月': 3, '五月': 4, '六月': 5,
  '七月': 6, '八月': 7, '九月': 8, '十月': 9, '十一月': 10, '十二月': 11,
};

function monthIndex(token: string): number | undefined {
  const t = token.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(MONTHS, t)) return MONTHS[t];
  const m = /^(\d{1,2})月$/.exec(t);
  if (m) {
    const n = parseInt(m[1] || '', 10);
    if (n >= 1 && n <= 12) return n - 1;
  }
  return undefined;
}

interface DateParts {
  y: number; mo: number; d: number; h: number; mi: number; s: number;
  /** Minutes east of UTC, when the value carried an offset. */
  offset: number | null;
}

const ISO_RE =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
const JIRA_RE =
  /^(\d{1,2})\/([^/\s]+)\/(\d{4}|\d{2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(am|pm|上午|下午)?$/i;

function num(s: string | undefined): number {
  return s ? parseInt(s, 10) : 0;
}

function parseDateParts(raw: string | null | undefined): DateParts | null {
  const s = normalizeText(raw);
  if (!s) return null;
  let parts: DateParts | null = null;

  const iso = ISO_RE.exec(s);
  if (iso) {
    let offset: number | null = null;
    const tz = iso[7];
    if (tz) {
      if (tz.toUpperCase() === 'Z') offset = 0;
      else {
        const digits = tz.replace(':', '');
        const sign = digits[0] === '-' ? -1 : 1;
        offset = sign * (num(digits.slice(1, 3)) * 60 + num(digits.slice(3, 5)));
      }
    }
    parts = {
      y: num(iso[1]), mo: num(iso[2]) - 1, d: num(iso[3]),
      h: num(iso[4]), mi: num(iso[5]), s: num(iso[6]), offset,
    };
  } else {
    const j = JIRA_RE.exec(s);
    if (!j) return null;
    const mo = monthIndex(j[2] || '');
    if (mo === undefined) return null;
    const yRaw = j[3] || '';
    let h = num(j[4]);
    const ap = (j[7] || '').toLowerCase();
    if (ap && h >= 1 && h <= 12) {
      const pm = ap === 'pm' || ap === '下午';
      if (pm && h !== 12) h += 12;
      if (!pm && h === 12) h = 0;
    }
    parts = {
      y: yRaw.length === 2 ? 2000 + num(yRaw) : num(yRaw),
      mo, d: num(j[1]), h, mi: num(j[5]), s: num(j[6]), offset: null,
    };
  }

  const { y, mo, d, h, mi, s: sec } = parts;
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) return null;
  const check = new Date(Date.UTC(y, mo, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo || check.getUTCDate() !== d) return null;
  return parts;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/**
 * Date + time → 'YYYY-MM-DDTHH:MM:SSZ' (UTC), or null when unparseable.
 * A value without an offset is wall-clock time in `timeZone` (UTC if omitted).
 */
export function parseJiraDateTime(raw: string | null | undefined, timeZone?: string): string | null {
  const p = parseDateParts(raw);
  if (!p) return null;
  const wall = Date.UTC(p.y, p.mo, p.d, p.h, p.mi, p.s);
  const ms =
    p.offset !== null ? wall - p.offset * 60_000
      : timeZone ? zonedToUtcMs(wall, timeZone)
        : wall;
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

/** Calendar date as written (time and offset ignored) → 'YYYY-MM-DD', or null. */
export function parseJiraDate(raw: string | null | undefined): string | null {
  const p = parseDateParts(raw);
  if (!p) return null;
  return `${p.y}-${pad2(p.mo + 1)}-${pad2(p.d)}`;
}

// ─── Sprints ────────────────────────────────────────────────────────────

export function extractSprintName(raw: string): string | null {
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
}

// ─── Jira wiki markup → HTML ────────────────────────────────────────────

/** Resolves a Jira account id (from `[~accountid:…]`) to a member, or null. */
export type MentionResolver = (accountId: string) => { name: string; memberId: string } | null;

export function textToHtml(text: string, resolve?: MentionResolver): string {
  if (!text) return '';

  // If content already contains HTML tags (like <p>, <h2>), return as-is
  // but still process mentions
  if (/<[a-z][\s\S]*>/i.test(text)) {
    let html = text;
    if (resolve) {
      html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m: string, accId: string) => {
        const hit = resolve(accId.trim());
        if (hit) return `<span class="mention" data-id="${hit.memberId}">@${hit.name}</span>`;
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
      result.push('<tr>' + cells.map((c) => `<th>${processInline(c.trim(), resolve)}</th>`).join('') + '</tr>');
      continue;
    }

    // Jira table data row: |col1|col2|
    if (/^\|[^|]/.test(line) && line.endsWith('|')) {
      if (inList) { for (let d = listLevel; d > 0; d--) result.push('</ul>'); inList = false; listLevel = 0; }
      if (!inTable) { result.push('<table>'); inTable = true; }
      const cells = line.slice(1, -1).split('|');
      result.push('<tr>' + cells.map((c) => `<td>${processInline(c.trim(), resolve)}</td>`).join('') + '</tr>');
      continue;
    }

    // Close table if we're no longer in table rows
    if (inTable) { result.push('</table>'); inTable = false; }

    // Jira headings: h1. h2. h3. h4. h5. h6.
    const headingMatch = line.match(/^h([1-6])\.\s+(.+)$/);
    if (headingMatch) {
      if (inList) { result.push('</ul>'); inList = false; }
      const level = headingMatch[1] || '1';
      const content = processInline(headingMatch[2] || '', resolve);
      result.push(`<h${level}>${content}</h${level}>`);
      continue;
    }

    // Jira bullet lists: * item, ** sub-item, *** sub-sub-item
    const bulletMatch = line.match(/^(\*+)\s+(.+)$/);
    if (bulletMatch) {
      const depth = (bulletMatch[1] || '*').length;
      const content = processInline(bulletMatch[2] || '', resolve);
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
      const content = processInline(numberedMatch[2] || '', resolve);
      if (!inList) { result.push('<ol>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style bullet: - item
    const mdBulletMatch = line.match(/^-\s+(.+)$/);
    if (mdBulletMatch) {
      const content = processInline(mdBulletMatch[1] || '', resolve);
      if (!inList) { result.push('<ul>'); inList = true; }
      result.push(`<li>${content}</li>`);
      continue;
    }

    // Markdown-style numbered: 1. item
    const mdNumMatch = line.match(/^\d+\.\s+(.+)$/);
    if (mdNumMatch) {
      const content = processInline(mdNumMatch[1] || '', resolve);
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
    result.push(`<p>${processInline(line, resolve)}</p>`);
  }

  // Close any remaining structures
  if (inTable) result.push('</table>');
  if (inList) {
    for (let d = listLevel; d > 0; d--) result.push('</ul>');
  }

  return result.join('\n');
}

// Process inline Jira wiki markup
function processInline(text: string, resolve?: MentionResolver): string {
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
  html = html.replace(/\[~accountid:([^\]]+)\]/g, (_m: string, accId: string) => {
    const hit = resolve ? resolve(accId.trim()) : null;
    if (hit) return `<span class="mention" data-id="${hit.memberId}">@${hit.name}</span>`;
    return '@成員';
  });
  return html;
}

// ─── Whole export ───────────────────────────────────────────────────────

export type PersonRole = 'assignee' | 'reporter' | 'creator' | 'commenter';

export interface JiraPerson {
  /** personKey() of the name — the identity used everywhere below. */
  key: string;
  /** Name as shown (normalized, first spelling seen). */
  name: string;
  roles: PersonRole[];
  /** Issues this person appears on (assignee, reporter, creator or commenter). */
  issueCount: number;
}

export interface JiraComment {
  /** Jira account id from the comment cell ("date;accountId;text"). */
  accountId: string;
  /** Person key of the author, when the account id maps to a known name. */
  authorKey: string | null;
  /** UTC timestamp. */
  createdAt: string | null;
  content: string;
}

export interface JiraAttachment {
  /** Jira attachment id — also the file name inside the site backup. */
  id: string;
  fileName: string;
  /** UTC timestamp. */
  uploadedAt: string | null;
  uploaderAccountId: string;
}

/** Issue types by role in the hierarchy (LIVO has one level of subtasks, no epics). */
export type IssueKind = 'epic' | 'subtask' | 'standard';

const ISSUE_KIND_ALIASES: Record<string, string[]> = {
  epic: ['Epic', '长篇故事', '大型工作'],
  subtask: ['Sub-task', 'Subtask', '子任务', '子任務'],
};
const ISSUE_KIND_LOOKUP = aliasLookup(ISSUE_KIND_ALIASES);

export function issueKind(issueType: string | null | undefined): IssueKind {
  return (ISSUE_KIND_LOOKUP.get(matchKey(issueType)) as IssueKind | undefined) || 'standard';
}

export interface JiraIssue {
  /** 1-based data row number (sort order). */
  row: number;
  key: string;
  projectKey: string;
  projectName: string;
  title: string;
  /** Base LIVO status id (s1–s7, unprefixed); importers resolve it with planStatuses. */
  statusId: string;
  /** The Jira status and status category as exported (normalized whitespace). */
  status: string;
  statusCategory: string;
  priority: string;
  kind: IssueKind;
  /** The Jira parent's key, when the export names one. */
  jiraParentKey: string | null;
  /** The parent to link in LIVO (parent_task_id); see parseJiraExport. */
  parentKey: string | null;
  assigneeKey: string | null;
  reporterKey: string | null;
  creatorKey: string | null;
  /** Calendar dates as written (YYYY-MM-DD). */
  created: string | null;
  resolved: string | null;
  due: string | null;
  start: string | null;
  /** UTC timestamps of created / resolved. */
  createdAt: string | null;
  resolvedAt: string | null;
  sprint: string | null;
  description: string;
  comments: JiraComment[];
  attachments: JiraAttachment[];
}

export interface HierarchyStats {
  /** Child → parent links that become LIVO subtasks. */
  linked: number;
  /** Children of an epic: LIVO has no epic field, so these stay unlinked. */
  epicChildren: number;
  /** Parent not in this CSV, or a second level LIVO cannot nest. */
  unlinked: number;
}

export type ParsedJiraExport =
  | { ok: false; error: 'no_data_rows' }
  | { ok: false; error: 'missing_columns'; missing: MissingColumn[]; detected: string[] }
  | {
      ok: true;
      totalRows: number;
      columns: JiraColumns;
      issues: JiraIssue[];
      people: JiraPerson[];
      /** Jira account id → person key (from the "… Id" columns). */
      accountPeople: Record<string, string>;
      sprintNames: string[];
      /** Distinct comment authors whose account id maps to no name. */
      unresolvedCommenters: number;
      hierarchy: HierarchyStats;
      attachmentCount: number;
    };

export interface ParseOptions {
  /** IANA zone the export's times are in (DEFAULT_TIME_ZONE when omitted). */
  timeZone?: string;
}

/** Project key from an issue key ("NOVA-12" → "NOVA"), used when the export has no project key. */
export function projectKeyFromIssueKey(issueKey: string): string {
  const m = /^([A-Za-z][A-Za-z0-9_]*)-\d+$/.exec(issueKey.trim());
  return m && m[1] ? m[1].toUpperCase() : '';
}

/** Attachment cell: "upload time;uploader account id;file name;…/attachment/content/<id>". */
export function parseAttachmentCell(raw: string, timeZone?: string): JiraAttachment | null {
  const parts = (raw || '').split(';');
  if (parts.length < 4) return null;
  const url = (parts[parts.length - 1] || '').trim();
  const m = /\/attachment\/content\/(\d+)/.exec(url) || /\/(\d+)\/?(?:[?#].*)?$/.exec(url);
  if (!m || !m[1]) return null;
  const fileName = parts.slice(2, -1).join(';').trim();
  if (!fileName) return null;
  return {
    id: m[1],
    fileName,
    uploadedAt: parseJiraDateTime(parts[0], timeZone),
    uploaderAccountId: (parts[1] || '').trim(),
  };
}

export function parseJiraExport(text: string, options: ParseOptions = {}): ParsedJiraExport {
  const timeZone = validTimeZone(options.timeZone) || DEFAULT_TIME_ZONE;
  const rows = parseCSV(text);
  if (rows.length < 2) return { ok: false, error: 'no_data_rows' };
  const columns = resolveColumns(rows[0] || []);
  if (columns.missing.length > 0) {
    return { ok: false, error: 'missing_columns', missing: columns.missing, detected: columns.detected };
  }
  const dataRows = rows.slice(1);
  const cell = (row: string[], field: JiraField): string => {
    const i = columns.index[field];
    return i === undefined ? '' : (row[i] || '').trim();
  };
  const cells = (row: string[], field: JiraField): string[] =>
    (columns.all[field] || []).map((i) => (row[i] || '').trim());

  // People, in order of first appearance.
  const people = new Map<string, { name: string; roles: Set<PersonRole>; issues: Set<string> }>();
  const touch = (rawName: string, role: PersonRole, issueKey: string): string | null => {
    const key = personKey(rawName);
    if (!key) return null;
    let p = people.get(key);
    if (!p) {
      p = { name: cleanPersonName(rawName), roles: new Set(), issues: new Set() };
      people.set(key, p);
    }
    p.roles.add(role);
    if (issueKey) p.issues.add(issueKey);
    return key;
  };

  // Account id → person (the "… Id" columns sit next to the name columns),
  // and Jira issue id → key (to resolve "Parent", which holds the parent's id).
  const accountPeople: Record<string, string> = {};
  const keyByIssueId: Record<string, string> = {};
  const idPairs: Array<[JiraField, JiraField]> = [
    ['assignee', 'assigneeId'], ['reporter', 'reporterId'], ['creator', 'creatorId'],
  ];
  for (const row of dataRows) {
    for (const [nameField, idField] of idPairs) {
      const name = cell(row, nameField);
      const id = cell(row, idField);
      if (name && id) accountPeople[id] = personKey(name);
    }
    const issueId = cell(row, 'issueId');
    const issueKey = cell(row, 'key');
    if (issueId && issueKey) keyByIssueId[issueId] = issueKey;
  }

  const sprintFromRow = (row: string[]): string | null => {
    const values = cells(row, 'sprint');
    // Prefer the last non-empty sprint cell (often the most recent)
    for (let j = values.length - 1; j >= 0; j--) {
      const name = extractSprintName(values[j] || '');
      if (name) return name;
    }
    return null;
  };

  // "Parent" usually holds the parent's issue id, 父项关键字 its key; accept either in both.
  const parentOf = (row: string[]): string | null => {
    for (const ref of [cell(row, 'parentKey'), cell(row, 'parent')]) {
      if (!ref) continue;
      if (/^\d+$/.test(ref)) {
        if (keyByIssueId[ref]) return keyByIssueId[ref];
      } else if (/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(ref)) {
        return ref;
      }
    }
    return null;
  };

  const issues: JiraIssue[] = [];
  const sprintNames: string[] = [];
  const seenSprints = new Set<string>();
  const seenKeys = new Set<string>();
  const unresolved = new Set<string>();
  let attachmentCount = 0;

  dataRows.forEach((row, r) => {
    // Sprints are collected from every row, as before.
    const sprint = sprintFromRow(row);
    if (sprint && !seenSprints.has(sprint)) {
      seenSprints.add(sprint);
      sprintNames.push(sprint);
    }

    const key = cell(row, 'key');
    if (!key || seenKeys.has(key)) return;
    const projectKey = cell(row, 'projectKey') || projectKeyFromIssueKey(key);
    if (!projectKey) return;
    seenKeys.add(key);

    const comments: JiraComment[] = [];
    for (const raw of cells(row, 'comment')) {
      if (!raw) continue;
      // Comment cell: "date;account id;content"
      const firstSemi = raw.indexOf(';');
      if (firstSemi < 0) continue;
      const secondSemi = raw.indexOf(';', firstSemi + 1);
      if (secondSemi < 0) continue;
      const content = raw.substring(secondSemi + 1).trim();
      if (!content) continue;
      comments.push({
        accountId: raw.substring(firstSemi + 1, secondSemi).trim(),
        authorKey: null, // resolved below, once every name column has been read
        createdAt: parseJiraDateTime(raw.substring(0, firstSemi), timeZone),
        content,
      });
    }

    const attachments: JiraAttachment[] = [];
    for (const raw of cells(row, 'attachment')) {
      const att = raw ? parseAttachmentCell(raw, timeZone) : null;
      if (att) attachments.push(att);
    }
    attachmentCount += attachments.length;

    issues.push({
      row: r + 1,
      key,
      projectKey,
      projectName: cell(row, 'projectName'),
      title: cell(row, 'title'),
      statusId: mapStatus(cell(row, 'status'), cell(row, 'statusCategory')),
      status: normalizeText(cell(row, 'status')),
      statusCategory: normalizeText(cell(row, 'statusCategory')),
      priority: mapPriority(cell(row, 'priority')),
      kind: issueKind(cell(row, 'issueType')),
      jiraParentKey: parentOf(row),
      parentKey: null,
      assigneeKey: touch(cell(row, 'assignee'), 'assignee', key),
      reporterKey: touch(cell(row, 'reporter'), 'reporter', key),
      creatorKey: touch(cell(row, 'creator'), 'creator', key),
      created: parseJiraDate(cell(row, 'created')),
      resolved: parseJiraDate(cell(row, 'resolved')),
      due: parseJiraDate(cell(row, 'dueDate')),
      start: parseJiraDate(cell(row, 'startDate')),
      createdAt: parseJiraDateTime(cell(row, 'created'), timeZone),
      resolvedAt: parseJiraDateTime(cell(row, 'resolved'), timeZone),
      sprint,
      description: cell(row, 'description'),
      comments,
      attachments,
    });
  });

  // Comment authors: account id → a person seen in a name column.
  for (const issue of issues) {
    for (const c of issue.comments) {
      const known = accountPeople[c.accountId];
      if (known && people.has(known)) {
        c.authorKey = known;
        const p = people.get(known);
        if (p) {
          p.roles.add('commenter');
          p.issues.add(issue.key);
        }
      } else if (c.accountId) {
        unresolved.add(c.accountId);
      }
    }
  }

  // Hierarchy → LIVO subtasks. LIVO nests exactly one level (parent_task_id)
  // and has no epic field, so: a link to an epic is dropped, and a link whose
  // parent has a parent of its own is dropped (the upper link wins).
  const byKey = new Map(issues.map((i) => [i.key, i]));
  const hierarchy: HierarchyStats = { linked: 0, epicChildren: 0, unlinked: 0 };
  const candidate = new Map<string, string>();
  for (const issue of issues) {
    const parent = issue.jiraParentKey ? byKey.get(issue.jiraParentKey) : undefined;
    if (!issue.jiraParentKey) continue;
    if (parent && parent.kind === 'epic') hierarchy.epicChildren++;
    else if (!parent || parent.key === issue.key) hierarchy.unlinked++;
    else candidate.set(issue.key, parent.key);
  }
  for (const [child, parent] of candidate) {
    if (candidate.has(parent)) {
      hierarchy.unlinked++;
      continue;
    }
    const issue = byKey.get(child);
    if (issue) issue.parentKey = parent;
    hierarchy.linked++;
  }

  return {
    ok: true,
    totalRows: dataRows.length,
    columns,
    issues,
    people: Array.from(people.entries()).map(([key, p]) => ({
      key,
      name: p.name,
      roles: (['assignee', 'reporter', 'creator', 'commenter'] as PersonRole[]).filter((role) => p.roles.has(role)),
      issueCount: p.issues.size,
    })),
    accountPeople,
    sprintNames,
    unresolvedCommenters: unresolved.size,
    hierarchy,
    attachmentCount,
  };
}

// ─── People → members ───────────────────────────────────────────────────

/** Imported people without a login get `<member id>@import.invalid` as a placeholder email. */
export const PLACEHOLDER_EMAIL_DOMAIN = 'import.invalid';

export function placeholderEmail(memberId: string): string {
  return `${memberId}@${PLACEHOLDER_EMAIL_DOMAIN}`;
}

/** True for members that have no real email (and so no login). */
export function isPlaceholderEmail(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return !e || e.endsWith('@' + PLACEHOLDER_EMAIL_DOMAIN);
}

export function normalizeEmail(email: string | null | undefined): string {
  return normalizeText(email).toLowerCase();
}

export function isValidEmail(email: string): boolean {
  if (!email || email.length > 254) return false;
  if (!/^[^\s@,;<>"'()]+@[^\s@,;<>"'()]+\.[a-z0-9-]{2,}$/i.test(email)) return false;
  return !/\.invalid$/i.test(email);
}

export interface ExistingMember {
  id: string;
  name: string;
  email: string;
  role: string;
  /** false for a disabled member (missing = active). */
  isActive?: boolean;
}

/** A "name, email" line from the admin's list. */
export interface AccountRequest {
  name: string;
  email: string;
}

/** Who already uses an email (members.email is unique across workspaces). */
export interface EmailOwner {
  memberId: string;
  name: string;
  sameWorkspace: boolean;
  /** True when the owning member already has a real email (a login). */
  hasLogin: boolean;
}

export type PersonPlan =
  | { kind: 'existing'; memberId: string; memberName: string; hasLogin: boolean; matchedBy: 'name' | 'email' }
  | { kind: 'activate'; memberId: string; memberName: string; email: string }
  | { kind: 'new_account'; memberId: string; email: string }
  | { kind: 'new_name_only'; memberId: string };

export type AccountIssueCode =
  | 'invalid_email'
  | 'duplicate_email'
  | 'conflicting_emails'
  | 'email_in_other_workspace'
  | 'member_has_login'
  | 'member_inactive'
  | 'requires_super_admin'
  | 'unknown_name';

export interface AccountIssue {
  code: AccountIssueCode;
  name: string;
  email?: string;
  /** Extra context: the other name sharing an email, the member's current email, … */
  detail?: string;
}

export interface MemberPlanInput {
  people: JiraPerson[];
  /** Members of the importing workspace, in a stable order (first match wins). */
  existing: ExistingMember[];
  accounts: AccountRequest[];
  /** normalizeEmail(email) → current owner, for every requested email. */
  emailOwners: Record<string, EmailOwner>;
  /** Only a super_admin may create the login of an admin / super_admin member. */
  callerIsSuperAdmin: boolean;
  /** Mints the id of each new member. */
  newMemberId: () => string;
}

export interface MemberPlan {
  plans: Record<string, PersonPlan>;
  errors: AccountIssue[];
  warnings: AccountIssue[];
}

const ADMIN_ROLES = ['admin', 'super_admin'];

export function planMembers(input: MemberPlanInput): MemberPlan {
  const errors: AccountIssue[] = [];
  const warnings: AccountIssue[] = [];
  const peopleKeys = new Set(input.people.map((p) => p.key));

  // Validate the email list. A person with a broken line gets no plan at
  // all (the preview shows the error, the real import refuses to start).
  const emailByPerson = new Map<string, string>();
  const personByEmail = new Map<string, string>();
  const broken = new Set<string>();
  for (const req of input.accounts) {
    const key = personKey(req.name);
    const name = cleanPersonName(req.name);
    const email = normalizeEmail(req.email);
    if (!key) continue;
    if (!isValidEmail(email)) {
      errors.push({ code: 'invalid_email', name, email: normalizeText(req.email) });
      broken.add(key);
      continue;
    }
    const prevEmail = emailByPerson.get(key);
    if (prevEmail !== undefined && prevEmail !== email) {
      errors.push({ code: 'conflicting_emails', name, email, detail: prevEmail });
      broken.add(key);
      continue;
    }
    const prevPerson = personByEmail.get(email);
    if (prevPerson !== undefined && prevPerson !== key) {
      const other = input.accounts.find((a) => personKey(a.name) === prevPerson);
      errors.push({ code: 'duplicate_email', name, email, detail: cleanPersonName(other ? other.name : prevPerson) });
      broken.add(key);
      continue;
    }
    emailByPerson.set(key, email);
    personByEmail.set(email, key);
    if (!peopleKeys.has(key)) warnings.push({ code: 'unknown_name', name, email });
  }

  const existingByKey = new Map<string, ExistingMember>();
  for (const m of input.existing) {
    const k = personKey(m.name);
    if (k && !existingByKey.has(k)) existingByKey.set(k, m);
  }

  const plans: Record<string, PersonPlan> = {};
  for (const person of input.people) {
    if (broken.has(person.key)) continue;
    const existing = existingByKey.get(person.key);
    const email = emailByPerson.get(person.key);

    if (!email) {
      plans[person.key] = existing
        ? { kind: 'existing', memberId: existing.id, memberName: existing.name, hasLogin: !isPlaceholderEmail(existing.email), matchedBy: 'name' }
        : { kind: 'new_name_only', memberId: input.newMemberId() };
      continue;
    }

    const owner = input.emailOwners[email];
    if (owner && !owner.sameWorkspace) {
      errors.push({ code: 'email_in_other_workspace', name: person.name, email });
      continue;
    }
    if (owner) {
      // The email already belongs to a member here: this person is that member.
      plans[person.key] = {
        kind: 'existing', memberId: owner.memberId, memberName: owner.name, hasLogin: owner.hasLogin,
        matchedBy: existing && existing.id === owner.memberId ? 'name' : 'email',
      };
      continue;
    }
    if (existing && !isPlaceholderEmail(existing.email)) {
      // Same name, different real email: never rewrite an existing login.
      errors.push({ code: 'member_has_login', name: person.name, email, detail: existing.email });
      continue;
    }
    if (existing) {
      // Same rule as 「啟用帳號」: a disabled member gets no login.
      if (existing.isActive === false) {
        errors.push({ code: 'member_inactive', name: person.name, email });
        continue;
      }
      if (ADMIN_ROLES.includes(existing.role) && !input.callerIsSuperAdmin) {
        errors.push({ code: 'requires_super_admin', name: person.name, email });
        continue;
      }
      plans[person.key] = { kind: 'activate', memberId: existing.id, memberName: existing.name, email };
      continue;
    }
    plans[person.key] = { kind: 'new_account', memberId: input.newMemberId(), email };
  }

  return { plans, errors, warnings };
}

/** Member id a person's tasks and comments point at (null while the plan has an error). */
export function planMemberId(plan: PersonPlan | undefined): string | null {
  return plan ? plan.memberId : null;
}

/** One row of the preview's people list. */
export interface PersonSummary {
  name: string;
  roles: PersonRole[];
  issueCount: number;
  plan: PersonPlan['kind'] | 'error';
  /** existing / activate: the LIVO member this person maps to. */
  memberName?: string;
  /** activate / new_account: the email the login gets; existing: the member's email. */
  email?: string;
  hasLogin?: boolean;
  matchedBy?: 'name' | 'email';
}

export function summarizePeople(people: JiraPerson[], plan: MemberPlan, existing: ExistingMember[]): PersonSummary[] {
  const emailById = new Map(existing.map((m) => [m.id, m.email]));
  return people.map((p) => {
    const base = { name: p.name, roles: p.roles, issueCount: p.issueCount };
    const pp = plan.plans[p.key];
    if (!pp) return { ...base, plan: 'error' as const };
    switch (pp.kind) {
      case 'existing': {
        const email = emailById.get(pp.memberId) || '';
        return {
          ...base, plan: pp.kind, memberName: pp.memberName, hasLogin: pp.hasLogin, matchedBy: pp.matchedBy,
          ...(isPlaceholderEmail(email) ? {} : { email }),
        };
      }
      case 'activate':
        return { ...base, plan: pp.kind, memberName: pp.memberName, email: pp.email };
      case 'new_account':
        return { ...base, plan: pp.kind, email: pp.email };
      default:
        return { ...base, plan: pp.kind };
    }
  });
}
