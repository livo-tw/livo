// Jira CSV importer (Cloudflare). Parsing, header aliases, status / priority /
// date mapping and the people → members plan live in ./jiraCsv (shared
// verbatim with the Docker importer); this file does the D1 side.
//
// Request: POST JSON { csv, dryRun?, accounts?: [{ name, email }], timeZone? }.
// A raw CSV body (text/plain, older clients) is a real import without
// accounts. timeZone is the IANA zone the export's times are in (Jira writes
// the exporting user's local time); Asia/Taipei when omitted.
//   - dryRun, or a non-professional caller (contract C2): preview only —
//     stats, the people list with what will happen to each person, account
//     errors; ZERO writes.
//   - otherwise the real import: it first wipes the workspace's tasks,
//     sprints, comments … (unchanged), then imports. People on the accounts
//     list get a real login (set-password invitation, or a one-time temporary
//     password when email sending is not configured); everyone else stays a
//     name-only member, as before.
// Jira statuses are resolved against the workspace's own statuses (which
// the customer may have renamed, deleted or added; see planStatuses).
// A CSV missing a required column, account errors, a CSV that yields no
// task, or a target status that no longer exists are refused before
// anything is written. Once the wipe has run, a failed write of projects,
// members, tasks, comments, specs or subtask links stops the import and is
// reported as a failure (import_failed), never as a success.

import type { Context } from 'hono';
import type { AppContext, Env } from '../env';
import { DEFAULT_WORKSPACE } from '../env';
import { TABLES } from '../tables';
import { valueToDb, nowIso } from '../meta';
import { notifyChanges } from '../notify';
import { checkProfessional } from '../license';
import { isMemberLimitError, memberLimitFailure } from '../memberQuota';
import {
  API_KEY_FORBIDDEN,
  deliverLogin,
  isApiKeyCaller,
  LoginError,
  prepareLogin,
  resolveLoginChannel,
  type LoginChannel,
} from '../memberLogin';
import {
  DEFAULT_TIME_ZONE,
  isValidEmail,
  normalizeEmail,
  parseJiraExport,
  placeholderEmail,
  planMemberId,
  planMembers,
  planStatuses,
  summarizePeople,
  textToHtml,
  validTimeZone,
  type AccountRequest,
  type EmailOwner,
  type ExistingMember,
  type MentionResolver,
  type PersonPlan,
  type WorkspaceStatus,
} from './jiraCsv';

/** A write after the wipe failed: the import stops and reports this step. */
class ImportStepError extends Error {
  constructor(readonly step: string, readonly cause: unknown) {
    super(`${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

// ── SQL identifier guard (all interpolated identifiers must pass) ──
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
function assertIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw new Error(`Invalid SQL identifier: ${name}`);
  return name;
}

/** "2026-04-01T..." → "2026-04-01"; strings without 'T' pass through unchanged. */
function dateOnlyPart(s: string): string {
  const i = s.indexOf('T');
  return i >= 0 ? s.slice(0, i) : s;
}

// ── D1 insert helper: registry-aware coercion + ≤80 bound params/statement ──
const MAX_PARAMS = 80;

function insertStatements(env: Env, table: string, rows: Record<string, unknown>[], workspaceId: string): D1PreparedStatement[] {
  if (rows.length === 0) return [];
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
  return stmts;
}

async function insertRows(env: Env, table: string, rows: Record<string, unknown>[], workspaceId: string): Promise<void> {
  const stmts = insertStatements(env, table, rows, workspaceId);
  if (stmts.length === 1) await stmts[0]!.run();
  else if (stmts.length > 1) await env.DB.batch(stmts);
}

// Row shapes (type aliases — object literals stay assignable to Record<string, unknown>)
type NewMemberRow = {
  id: string; name: string; avatar: string; role: string;
  email: string; color: string; job_title: string; is_active: boolean;
  auth_id?: string;
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

const newMemberRow = (id: string, name: string, email: string): NewMemberRow => ({
  id, name, avatar: name[0]?.toUpperCase() || '?',
  // email must be unique per member: members has a UNIQUE (nocase) index on
  // email, so name-only members get a per-id placeholder.
  role: 'member', email, color: '#6B778C', job_title: '', is_active: true,
});

interface ImportRequest {
  csv: string;
  dryRun: boolean;
  accounts: AccountRequest[];
  timeZone: string;
}

async function readImportRequest(c: Context<AppContext>): Promise<ImportRequest | null> {
  const raw = await c.req.text();
  if (!(c.req.header('Content-Type') || '').includes('application/json')) {
    return { csv: raw, dryRun: false, accounts: [], timeZone: DEFAULT_TIME_ZONE }; // older clients post the bare CSV
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  const b = body as { csv?: unknown; dryRun?: unknown; accounts?: unknown; timeZone?: unknown };
  if (typeof b.csv !== 'string') return null;
  const accounts = Array.isArray(b.accounts)
    ? b.accounts
        .filter((a): a is Record<string, unknown> => !!a && typeof a === 'object')
        .slice(0, 2000)
        .map((a) => ({ name: String(a.name ?? ''), email: String(a.email ?? '') }))
    : [];
  const timeZone = validTimeZone(typeof b.timeZone === 'string' ? b.timeZone : null) || DEFAULT_TIME_ZONE;
  return { csv: b.csv, dryRun: b.dryRun === true, accounts, timeZone };
}

/** Current owners of the requested emails. members.email is unique across
 *  workspaces (requireMember heals logins by email), so the lookup is
 *  deliberately global; another workspace's member is reported without a name. */
async function loadEmailOwners(env: Env, ws: string, accounts: AccountRequest[]): Promise<Record<string, EmailOwner>> {
  const emails = Array.from(new Set(accounts.map((a) => normalizeEmail(a.email)).filter(isValidEmail)));
  const owners: Record<string, EmailOwner> = {};
  for (let i = 0; i < emails.length; i += 50) {
    const chunk = emails.slice(i, i + 50);
    const res = await env.DB
      .prepare(`SELECT id, name, email, workspace_id FROM members WHERE lower(email) IN (${chunk.map(() => '?').join(', ')})`)
      .bind(...chunk)
      .all<{ id: string; name: string; email: string; workspace_id: string | null }>();
    for (const m of res.results || []) {
      const sameWorkspace = (m.workspace_id || DEFAULT_WORKSPACE) === ws;
      owners[normalizeEmail(m.email)] = {
        memberId: sameWorkspace ? m.id : '',
        name: sameWorkspace ? m.name : '',
        sameWorkspace,
        hasLogin: true,
      };
    }
  }
  return owners;
}

type AccountPlan = Extract<PersonPlan, { kind: 'new_account' } | { kind: 'activate' }>;

interface AccountsResult {
  method: LoginChannel['method'];
  invited: { name: string; email: string }[];
  credentials: { name: string; email: string; password: string; inviteFailed?: boolean }[];
  failed: { name: string; email: string; reason: string }[];
}

/** Runs `fn` over `items` with at most `limit` in flight (Resend calls). */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

// ── Handler (requireMember + requireAdmin already applied in index.ts) ──
export const handleImportJira = async (c: Context<AppContext>) => {
  const env = c.env;
  // What the destructive path has written so far (reported if it fails midway).
  const written = {
    wiped: false,
    tasksInserted: 0,
    commentsInserted: 0,
    specsInserted: 0,
    accounts: null as AccountsResult | null,
  };
  try {
    // Tenancy scope: every read/write below (license gate, wipe, inserts,
    // updates) is confined to the caller's workspace.
    const auth = c.get('auth');
    const ws = auth.member.workspaceId;
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

    // Tier behavior (contract C2): non-professional callers get a SAFE DRY-RUN.
    const isPro = await checkProfessional(env, ws);

    const request = await readImportRequest(c);
    if (!request) return c.json({ error: 'invalid_request', message: '請求格式不正確' }, 400);
    // Opening logins is refused to API keys (same rule as manage-member).
    if (isApiKeyCaller(auth) && !request.dryRun && request.accounts.length > 0) {
      return c.json(API_KEY_FORBIDDEN, 403);
    }
    console.log('CSV length:', request.csv.length);

    const parsed = parseJiraExport(request.csv, { timeZone: request.timeZone });
    if (!parsed.ok) {
      if (parsed.error === 'no_data_rows') {
        return c.json({ error: 'no_data_rows', message: 'CSV 沒有任何資料列' }, 400);
      }
      return c.json(
        {
          error: 'missing_columns',
          message: `CSV 缺少必要欄位：${parsed.missing.map((m) => m.accepted.join(' / ')).join('、')}`,
          missingColumns: parsed.missing,
          detectedColumns: parsed.detected.slice(0, 500),
        },
        400
      );
    }
    console.log('Parsed issues:', parsed.issues.length, 'people:', parsed.people.length);

    // ── Statuses: this workspace's own list (renamed / deleted / added ones
    //    included); every task gets the id of a status that exists. ──
    const statusRes = await env.DB
      .prepare('SELECT id, name, sort_order, is_done, auto_start FROM statuses WHERE workspace_id = ?')
      .bind(ws)
      .all<WorkspaceStatus>();
    const statusPlan = planStatuses(parsed.issues, statusRes.results || [], {
      idPrefix: ws === DEFAULT_WORKSPACE ? '' : `${ws8}-`,
    });
    if (statusPlan.ok !== true) {
      return c.json({ error: 'no_statuses', message: '這個團隊還沒有任何任務狀態，請先到「狀態管理」新增' }, 400);
    }

    // ── People → members (plan only; nothing is written yet) ──
    const existingRes = await env.DB
      .prepare('SELECT id, name, email, role, is_active FROM members WHERE workspace_id = ? ORDER BY sort_order, id')
      .bind(ws)
      .all<{ id: string; name: string; email: string | null; role: string | null; is_active: number | null }>();
    const existing: ExistingMember[] = (existingRes.results || []).map((m) => ({
      id: m.id, name: m.name, email: m.email || '', role: m.role || 'member', isActive: m.is_active !== 0,
    }));
    // Re-imports must not recycle already-taken uN ids.
    let memberCounter = 10;
    for (const m of existing) {
      const um = /^(?:[0-9a-f]{8}-)?u(\d+)$/.exec(m.id); // tolerate the <ws8>- prefix
      if (um) memberCounter = Math.max(memberCounter, parseInt(um[1]!, 10) + 1);
    }
    const memberPlan = planMembers({
      people: parsed.people,
      existing,
      accounts: request.accounts,
      emailOwners: await loadEmailOwners(env, ws, request.accounts),
      callerIsSuperAdmin: auth.member.role === 'super_admin',
      newMemberId: () => scopedId(`u${memberCounter++}`),
    });
    const personName = new Map(parsed.people.map((p) => [p.key, p.name]));
    // Fallback identity for rows with no resolvable reporter/creator: the
    // importing admin (the legacy hardcoded 'u1' doesn't exist on fresh installs).
    const fallbackMemberId = auth.member.id;
    const memberIdOf = (key: string | null): string | null => (key ? planMemberId(memberPlan.plans[key]) : null);
    const mention: MentionResolver = (accountId) => {
      const key = parsed.accountPeople[accountId];
      const name = key ? personName.get(key) : undefined;
      return name ? { name, memberId: memberIdOf(key!) || '' } : null;
    };

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

    // ── Tasks + comments + specs in memory (sprint ids are generated here so
    //    tasks can reference them; still NO DB write) ──
    const sprintMap = new Map<string, string>(); // jira sprint name → db sprint id
    for (const name of parsed.sprintNames) sprintMap.set(name, crypto.randomUUID());
    const today = dateOnlyPart(new Date().toISOString());
    const tasks: TaskRow[] = [];
    const comments: CommentRow[] = [];
    const taskSpecs: SpecRow[] = [];
    let commentId = 1;
    let specId = 1;
    for (const issue of parsed.issues) {
      const taskId = scopedId(issue.key); // display key stays raw; the id must be globally unique
      const createdAt = issue.created || today;
      for (const cm of issue.comments) {
        comments.push({
          id: scopedId(`c${String(commentId++).padStart(5, '0')}`),
          task_id: taskId,
          user_id: memberIdOf(cm.authorKey) || fallbackMemberId,
          content: textToHtml(cm.content, mention),
          created_at: cm.createdAt || createdAt,
        });
      }
      if (issue.description) {
        taskSpecs.push({
          id: scopedId(`ts${String(specId++).padStart(5, '0')}`),
          task_id: taskId,
          background: '',
          requirement: textToHtml(issue.description, mention),
          notes: '',
        });
      }
      tasks.push({
        id: taskId,
        task_key: issue.key,
        project_id: projectIdFor(issue.projectKey, issue.projectName),
        title: issue.title,
        status_id: statusPlan.statusIdOf(issue.key),
        priority: issue.priority,
        // Reporter (报告人) = reviewer & card creator; Jira's creator is the fallback.
        creator_id: memberIdOf(issue.reporterKey) || memberIdOf(issue.creatorKey) || fallbackMemberId,
        assignee_id: memberIdOf(issue.assigneeKey),
        reviewer_id: memberIdOf(issue.reporterKey),
        due_date: issue.due,
        started_at: issue.start,
        completed_at: issue.resolved,
        sort_order: issue.row,
        created_at: createdAt,
        comment_count: issue.comments.length,
        sprint_id: issue.sprint ? sprintMap.get(issue.sprint) || null : null,
        // Department is back-filled from members.job_title after insert.
        department: null,
      });
    }
    // Done-ness follows the workspace status each task landed on.
    const doneTaskIds = new Set(tasks.filter((t) => statusPlan.isDone(t.status_id)).map((t) => t.id));
    // Exact (UTC) created / resolved instants for the sprint dates below.
    const instants = new Map(parsed.issues.map((i) => [scopedId(i.key), { createdAt: i.createdAt, resolvedAt: i.resolvedAt }]));
    // Subtask links, applied after every task row exists (parent_task_id is a FK).
    const parentLinks = new Map<string, string[]>(); // parent task id → child task ids
    for (const issue of parsed.issues) {
      if (!issue.parentKey) continue;
      const parentId = scopedId(issue.parentKey);
      parentLinks.set(parentId, [...(parentLinks.get(parentId) || []), scopedId(issue.key)]);
    }

    const plans = Object.entries(memberPlan.plans);
    const newMemberCount = plans.filter(([, p]) => p.kind === 'new_account' || p.kind === 'new_name_only').length;
    const loginChannel = await resolveLoginChannel(env, ws);

    // ── Stats (identical shape for both dry-run and real import) ──
    const stats = {
      totalRows: parsed.totalRows,
      tasksParsed: tasks.length,
      commentsParsed: comments.length,
      specsParsed: taskSpecs.length,
      sprintsParsed: sprintMap.size,
      subtasksLinked: parsed.hierarchy.linked,
      epicChildren: parsed.hierarchy.epicChildren,
      attachmentsParsed: parsed.attachmentCount,
      timeZone: request.timeZone,
      newMembers: plans
        .filter(([, p]) => p.kind === 'new_account' || p.kind === 'new_name_only')
        .map(([key]) => personName.get(key) || key),
      newProjects: Array.from(newProjects.values()).map((p) => p.name),
    };

    // ── Beta member cap (same rule as manage-member create): the import
    //    would otherwise mint an active member row per distinct CSV name,
    //    blowing past workspaces.member_limit and then wedging 成員管理. ──
    if (ws !== DEFAULT_WORKSPACE && newMemberCount > 0) {
      const quota = await env.DB
        .prepare(
          `SELECT w.member_limit AS lim,
                  (SELECT COUNT(*) FROM members m WHERE m.workspace_id = w.id AND m.is_active = 1) AS used
           FROM workspaces w WHERE w.id = ?1`
        )
        .bind(ws)
        .first<{ lim: number; used: number }>();
      if (quota && quota.used + newMemberCount > quota.lim) {
        return c.json(
          {
            error: 'member_limit', code: 'member_limit',
            message: `匯入將新增 ${newMemberCount} 位成員，超過 Beta 成員上限（${quota.lim} 人）。請先精簡 CSV 中的人員，或聯繫 service@livo-tw.com`,
            stats,
          },
          403
        );
      }
    }

    // ── Preview (dryRun, or contract C2 for non-pro): nothing written. ──
    if (!isPro || request.dryRun) {
      console.log('[import-jira] preview:', JSON.stringify({ ...stats, newMembers: stats.newMembers.length }));
      return c.json({
        success: true,
        dryRun: true,
        canImport: isPro,
        stats,
        people: summarizePeople(parsed.people, memberPlan, existing),
        accountErrors: memberPlan.errors,
        accountWarnings: memberPlan.warnings,
        unresolvedCommenters: parsed.unresolvedCommenters,
        loginMethod: loginChannel.method,
        statusMapping: statusPlan.mapping,
      });
    }

    // Refuse BEFORE the wipe: a half-right accounts list or an empty result
    // would otherwise cost the workspace its data.
    if (memberPlan.errors.length > 0) {
      return c.json(
        { error: 'account_errors', message: 'Email 對照表有問題，請修正後再匯入', accountErrors: memberPlan.errors },
        400
      );
    }
    if (tasks.length === 0) {
      return c.json({ error: 'no_tasks', message: 'CSV 裡沒有可匯入的任務（每列都需要事務密鑰 / Issue key）', stats }, 400);
    }
    // Every target status must still exist right before the wipe (tasks.status_id is a FK).
    const targetStatusIds = Array.from(new Set(tasks.map((t) => t.status_id)));
    const presentStatuses = new Set<string>();
    for (let i = 0; i < targetStatusIds.length; i += MAX_PARAMS - 1) {
      const chunk = targetStatusIds.slice(i, i + MAX_PARAMS - 1);
      const res = await env.DB
        .prepare(`SELECT id FROM statuses WHERE workspace_id = ? AND id IN (${chunk.map(() => '?').join(', ')})`)
        .bind(ws, ...chunk)
        .all<{ id: string }>();
      for (const r of res.results || []) presentStatuses.add(r.id);
    }
    const missingStatuses = targetStatusIds.filter((id) => !presentStatuses.has(id));
    if (missingStatuses.length > 0) {
      return c.json(
        {
          error: 'status_missing',
          message: '要對應的任務狀態已不存在（可能剛被刪除），請重新預覽後再匯入',
          missingStatuses,
        },
        409
      );
    }

    // ═══ Professional path: the real, DESTRUCTIVE import (writes begin here) ═══
    if(await env.DB.prepare('SELECT id FROM release_batches WHERE workspace_id=? LIMIT 1').bind(ws).first())return c.json({error:'release_history_requires_restore',message:'發布批次與證據須透過完整伺服器備份還原，不能覆蓋匯入。'},409);
    const pendingApproval=await env.DB.prepare(`SELECT id FROM approval_requests WHERE workspace_id=? AND status='pending'
      UNION ALL SELECT id FROM tasks WHERE workspace_id=? AND (current_approval_id IS NOT NULL OR approval_status='pending_approval') LIMIT 1`).bind(ws,ws).first();
    if(pendingApproval) return c.json({error:'approval_pending',message:'尚有簽核中的任務，請先撤回或完成簽核後再匯入。'},409);

    // ── Clear existing data (atomic batch, original table order) — only the
    //    caller's workspace; other tenants' rows are untouchable. ──
    console.log('Clearing existing data...');
    await env.DB.batch(
      [env.DB.prepare('INSERT INTO task_planning_import_guard(workspace_id) VALUES(?)').bind(ws),
        ...CLEAR_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${assertIdent(t)} WHERE workspace_id = ?`).bind(ws)),
        env.DB.prepare('DELETE FROM task_planning_import_guard WHERE workspace_id=?').bind(ws)]
    );
    written.wiped = true;
    // Steps after the wipe that may only warn (the data itself is in place).
    const warnings: string[] = [];

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
      throw new ImportStepError('projects', error);
    }

    // ── Members. Name-only people first (as before) ──
    const nameOnly = plans
      .filter((e): e is [string, Extract<PersonPlan, { kind: 'new_name_only' }>] => e[1].kind === 'new_name_only')
      .map(([key, p]) => newMemberRow(p.memberId, personName.get(key) || key, placeholderEmail(p.memberId)));
    if (nameOnly.length > 0) {
      console.log('Creating name-only members:', nameOnly.length);
      try {
        await insertRows(env, 'members', nameOnly, ws);
      } catch (error) {
        throw new ImportStepError('members', error);
      }
    }

    // ── …then the people on the accounts list: login + member in one batch
    //    each, then the invitation / temporary password. A failure keeps the
    //    person as a name-only member so their tasks still import. ──
    const accountsResult: AccountsResult = { method: loginChannel.method, invited: [], credentials: [], failed: [] };
    written.accounts = accountsResult;
    let memberFallbackError: unknown = null;
    const accountPlans = plans.filter((e): e is [string, AccountPlan] => e[1].kind === 'new_account' || e[1].kind === 'activate');
    let membersTouched = nameOnly.length > 0;
    await mapLimit(accountPlans, 4, async ([key, p]) => {
      const name = personName.get(key) || key;
      let memberWritten = false;
      try {
        const login = await prepareLogin(env, p.email, loginChannel.method);
        const memberStmts =
          p.kind === 'new_account'
            ? insertStatements(env, 'members', [{ ...newMemberRow(p.memberId, name, p.email), auth_id: login.authUserId }], ws)
            : [
                env.DB
                  .prepare('UPDATE members SET email = ?1, auth_id = ?2 WHERE id = ?3 AND workspace_id = ?4')
                  .bind(p.email, login.authUserId, p.memberId, ws),
              ];
        await env.DB.batch([...login.statements, ...memberStmts]);
        memberWritten = true;
        membersTouched = true;
        const delivery = await deliverLogin(env, loginChannel, login, { name, email: p.email, invitedBy: auth.member.name });
        if (delivery.method === 'invite') accountsResult.invited.push({ name, email: p.email });
        else {
          accountsResult.credentials.push({
            name, email: p.email, password: delivery.tempPassword || '',
            ...(delivery.inviteFailed ? { inviteFailed: true } : {}),
          });
        }
      } catch (error) {
        if (isMemberLimitError(error)) {
          accountsResult.failed.push({ name, email: p.email, reason: 'member_limit' });
          memberFallbackError = error;
          return;
        }
        console.error('Create login error:', name, error);
        if (memberWritten) {
          // Member and login exist; only the invitation / password step failed.
          accountsResult.failed.push({ name, email: p.email, reason: 'delivery_failed' });
          return;
        }
        const taken = error instanceof LoginError || /UNIQUE/i.test(String(error));
        accountsResult.failed.push({ name, email: p.email, reason: taken ? 'email_taken' : 'create_failed' });
        if (p.kind === 'new_account') {
          try {
            await insertRows(env, 'members', [newMemberRow(p.memberId, name, placeholderEmail(p.memberId))], ws);
            membersTouched = true;
          } catch (fallbackError) {
            if (!isMemberLimitError(fallbackError)) console.error('Insert fallback member error:', fallbackError);
            memberFallbackError = fallbackError;
          }
        }
      }
    });

    // Without the member row every task that points at this person would fail.
    if (memberFallbackError) throw new ImportStepError('members', memberFallbackError);

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
        warnings.push('sprints');
        sprintMap.clear(); // failed sprints must not be referenced by tasks
        for (const t of tasks) t.sprint_id = null;
      }
    }
    console.log('Created sprints:', Array.from(sprintMap.keys()));

    console.log(`Inserting ${tasks.length} tasks, ${comments.length} comments, ${taskSpecs.length} specs`);

    // Insert tasks in slices of 50, then comments (100) and specs (50). Each
    // slice is atomic; a failed slice stops the import (import_failed) instead
    // of being skipped, so a half-written import is never reported as done.
    for (let i = 0; i < tasks.length; i += 50) {
      const batch = tasks.slice(i, i + 50);
      try {
        await insertRows(env, 'tasks', batch, ws);
        written.tasksInserted += batch.length;
      } catch (error) {
        console.error(`Insert tasks batch ${i} error:`, error, 'First task:', JSON.stringify(batch[0]));
        throw new ImportStepError('tasks', error);
      }
    }
    for (let i = 0; i < comments.length; i += 100) {
      const batch = comments.slice(i, i + 100);
      try {
        await insertRows(env, 'comments', batch, ws);
        written.commentsInserted += batch.length;
      } catch (error) {
        throw new ImportStepError('comments', error);
      }
    }
    for (let i = 0; i < taskSpecs.length; i += 50) {
      const batch = taskSpecs.slice(i, i + 50);
      try {
        await insertRows(env, 'task_specs', batch, ws);
        written.specsInserted += batch.length;
      } catch (error) {
        throw new ImportStepError('specs', error);
      }
    }

    // ── Subtasks: parent_task_id, now that every task row exists ──
    let subtasksLinked = 0;
    try {
      const linkStmts: D1PreparedStatement[] = [];
      for (const [parentId, childIds] of parentLinks) {
        for (let i = 0; i < childIds.length; i += MAX_PARAMS - 2) {
          const chunk = childIds.slice(i, i + MAX_PARAMS - 2);
          linkStmts.push(
            env.DB
              .prepare(`UPDATE tasks SET parent_task_id = ? WHERE id IN (${chunk.map(() => '?').join(', ')}) AND workspace_id = ?`)
              .bind(parentId, ...chunk, ws)
          );
        }
      }
      for (let i = 0; i < linkStmts.length; i += 50) {
        await env.DB.batch(linkStmts.slice(i, i + 50));
      }
      subtasksLinked = Array.from(parentLinks.values()).reduce((n, ids) => n + ids.length, 0);
    } catch (error) {
      throw new ImportStepError('subtasks', error);
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
      warnings.push('departments');
    }

    // Update sprint dates and counts from task data
    // started_at = earliest created_at of tasks in this sprint
    // completed_at = latest completed_at of tasks in this sprint
    try {
      const sprintStmts: D1PreparedStatement[] = [];
      for (const sprintId of sprintMap.values()) {
        const sprintTasks = tasks.filter((t) => t.sprint_id === sprintId);
        const completedCount = sprintTasks.filter((t) => doneTaskIds.has(t.id)).length;
        const pendingCount = sprintTasks.length - completedCount;

        // started_at: earliest creation among tasks in this sprint (exact
        // UTC instant when the export had a time, else the calendar date)
        const createdDates = sprintTasks
          .map((t) => new Date(instants.get(t.id)?.createdAt || t.created_at).getTime())
          .filter((ts) => !isNaN(ts));
        const minCreated = createdDates.length > 0 ? new Date(Math.min(...createdDates)) : null;

        // completed_at: latest resolution among tasks in this sprint
        const completedDates = sprintTasks
          .filter((t) => t.completed_at)
          .map((t) => new Date(instants.get(t.id)?.resolvedAt || (t.completed_at as string)).getTime())
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
      warnings.push('sprint_stats');
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
      const uncompletedTaskIds = tasks.filter((t) => !doneTaskIds.has(t.id)).map((t) => t.id);

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
      warnings.push('active_sprint');
    }

    // Synthetic refresh pings (DESIGN decision: no per-row flood; sprints/projects
    // config-table pings trigger refreshTasks on other connected clients).
    // (cast: hono's minimal ExecutionContext type lacks workers-types v5 extras)
    const execCtx = c.executionCtx as ExecutionContext;
    const pings: { table: string; eventType: 'UPDATE'; new: null; old: null }[] = [
      { table: 'sprints', eventType: 'UPDATE', new: null, old: null },
      { table: 'projects', eventType: 'UPDATE', new: null, old: null },
    ];
    // Import-created members and new logins must propagate to other clients too.
    if (membersTouched) {
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
        tasksInserted: written.tasksInserted,
        commentsInserted: written.commentsInserted,
        specsInserted: written.specsInserted,
        sprintsCreated: sprintMap.size,
        subtasksLinked,
      },
      accounts: accountsResult,
      warnings,
    });
  } catch (err) {
    if (isMemberLimitError(err)) {
      const failure = await memberLimitFailure(env, c.get('auth').member.workspaceId || DEFAULT_WORKSPACE);
      return c.json({ ...failure, ...(written.wiped ? {
        error: 'import_failed',
        message: `${failure.message} 匯入未完成；原有工作資料已清除，新資料可能只寫入一部分。請確認名額後重新匯入同一份 CSV。`,
        step: err instanceof ImportStepError ? err.step : 'members',
        partial: { tasksInserted: written.tasksInserted, commentsInserted: written.commentsInserted, specsInserted: written.specsInserted },
        accounts: written.accounts,
      } : {}) }, 403);
    }
    if(!written.wiped && err instanceof Error && err.message.includes('approval_pending'))return c.json({error:'approval_pending',message:'仍有待處理簽核，原有資料未變更。'},409);
    if(!written.wiped && err instanceof Error && /work_history_requires_restore|qa_task_links_require_restore/.test(err.message))return c.json({error:err.message.includes('qa_task_links_require_restore')?'qa_task_links_require_restore':'work_history_requires_restore',message:'此工作區保留任務操作歷史，請使用完整伺服器備份還原。'},409);
    if(!written.wiped && err instanceof Error && err.message.includes('knowledge_requires_server_restore'))return c.json({error:'knowledge_requires_server_restore',message:'知識庫文件引用了現有任務或 QA，無法覆蓋匯入。請使用完整伺服器備份還原，原資料已保留。'},409);
    if(!written.wiped && err instanceof Error && err.message.includes('planning_history_requires_restore'))return c.json({error:'planning_history_requires_restore',message:'此工作區保留期限異動或個人提醒設定，無法覆蓋匯入。請使用完整伺服器備份還原。'},409);
    console.error('Import error:', err);
    if (written.wiped) {
      // The wipe ran but the import did not finish: say so, with what landed
      // and any logins already created (their temporary passwords included).
      return c.json(
        {
          error: 'import_failed',
          step: err instanceof ImportStepError ? err.step : 'unknown',
          message: '匯入沒有完成：原有資料已清除，新資料只寫入一部分。請修正問題後重新匯入同一份 CSV。',
          detail: err instanceof Error ? err.message : String(err),
          partial: {
            tasksInserted: written.tasksInserted,
            commentsInserted: written.commentsInserted,
            specsInserted: written.specsInserted,
          },
          accounts: written.accounts,
        },
        500
      );
    }
    return c.json({ error: String(err) }, 500);
  }
};
