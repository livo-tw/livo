// Jira CSV importer (self-hosted edge function). Mirrors
// worker/src/functions/importJira.ts; parsing, header aliases, status /
// priority / date mapping and the people → members plan come from
// ./jiraCsv.ts, logins from ./memberAccounts.ts (copies shared with the
// worker / manage-member — `npm run sync:shared`).
//
// Request: POST JSON { csv, dryRun?, accounts?: [{ name, email }], timeZone? }.
// A raw CSV body (text/plain, older clients) is a real import without
// accounts. timeZone is the IANA zone the export's times are in (Jira writes
// the exporting user's local time); Asia/Taipei when omitted.
//   - dryRun, or a non-professional caller (contract C2): preview only —
//     stats, the people list with what will happen to each person, account
//     errors; ZERO writes.
//   - otherwise the real import: it first wipes tasks, sprints, comments …
//     (unchanged), then imports. People on the accounts list get a real login
//     (set-password invitation, or a one-time temporary password when no
//     Resend key is bound); everyone else stays a name-only member, as before.
// A CSV missing a required column, account errors, or a CSV that yields no
// task are refused before anything is written.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import {
  DEFAULT_TIME_ZONE,
  isPlaceholderEmail,
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
} from "./jiraCsv.ts";
import {
  API_KEY_FORBIDDEN,
  deliverLogin,
  discardLogin,
  isApiKeyToken,
  loadAuthUsersByEmail,
  LoginError,
  prepareLogin,
  resolveLoginChannel,
  type LoginChannel,
} from "./memberAccounts.ts";

/** A write after the wipe failed: the import stops and reports this step. */
class ImportStepError extends Error {
  constructor(readonly step: string, detail: unknown) {
    super(`${step}: ${detail instanceof Error ? detail.message : typeof detail === 'object' && detail && 'message' in detail ? String((detail as { message: unknown }).message) : String(detail)}`);
  }
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// ── License check (inline — docker tree functions are self-contained) ──
type LicenseTier = 'none' | 'standard' | 'professional';

async function verifyLicense(supabase: any): Promise<{ tier: LicenseTier; isValid: boolean }> {
  try {
    const { data, error } = await supabase.rpc('check_license');
    if (error) throw error;
    return {
      tier: data?.valid ? (data.tier as LicenseTier) : 'none',
      isValid: data?.valid || false,
    };
  } catch (e) {
    console.error('[license] check_license RPC failed:', e);
    return { tier: 'none', isValid: false };
  }
}

/** "2026-04-01T..." → "2026-04-01"; strings without 'T' pass through unchanged. */
function dateOnlyPart(s: string): string {
  const i = s.indexOf('T');
  return i >= 0 ? s.slice(0, i) : s;
}

// Resolve the importing user's member id from the Authorization header.
// Falls back to the first admin, then the first member, then legacy 'u1' —
// the legacy hardcoded 'u1' doesn't exist on fresh customer installs and
// would make every task insert fail its creator_id FK.
async function resolveImporterMemberId(supabase: any, req: Request): Promise<string> {
  try {
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace(/^Bearer\s+/i, '').trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      const user = userData?.user;
      if (user) {
        const { data: byAuthId } = await supabase
          .from('members').select('id').eq('auth_id', user.id).limit(1);
        if (byAuthId && byAuthId[0]?.id) return byAuthId[0].id;
        if (user.email) {
          const { data: byEmail } = await supabase
            .from('members').select('id').eq('email', user.email).limit(1);
          if (byEmail && byEmail[0]?.id) return byEmail[0].id;
        }
      }
    }
  } catch (e) {
    console.error('Resolve importer error:', e);
  }
  try {
    const { data: admins } = await supabase
      .from('members').select('id').in('role', ['super_admin', 'admin']).limit(1);
    if (admins && admins[0]?.id) return admins[0].id;
    const { data: anyMember } = await supabase.from('members').select('id').limit(1);
    if (anyMember && anyMember[0]?.id) return anyMember[0].id;
  } catch (e) {
    console.error('Fallback member lookup error:', e);
  }
  return 'u1';
}

// Row shapes
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

const newMemberRow = (id: string, name: string, email: string): NewMemberRow => ({
  id, name, avatar: name[0]?.toUpperCase() || '?',
  // email must be unique per member — name-only members get a per-id placeholder.
  role: 'member', email, color: '#6B778C', job_title: '', is_active: true,
});

interface ImportRequest {
  csv: string;
  dryRun: boolean;
  accounts: AccountRequest[];
  timeZone: string;
}

async function readImportRequest(req: Request): Promise<ImportRequest | null> {
  const raw = await req.text();
  if (!(req.headers.get('Content-Type') || '').includes('application/json')) {
    return { csv: raw, dryRun: false, accounts: [], timeZone: DEFAULT_TIME_ZONE }; // older clients post the bare CSV
  }
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!body || typeof body !== 'object' || typeof body.csv !== 'string') return null;
  const accounts = Array.isArray(body.accounts)
    ? body.accounts
        .filter((a: unknown) => !!a && typeof a === 'object')
        .slice(0, 2000)
        .map((a: any) => ({ name: String(a.name ?? ''), email: String(a.email ?? '') }))
    : [];
  const timeZone = validTimeZone(typeof body.timeZone === 'string' ? body.timeZone : null) || DEFAULT_TIME_ZONE;
  return { csv: body.csv, dryRun: body.dryRun === true, accounts, timeZone };
}

type AccountPlan = Extract<PersonPlan, { kind: 'new_account' } | { kind: 'activate' }>;

interface AccountsResult {
  method: LoginChannel['method'];
  invited: { name: string; email: string }[];
  credentials: { name: string; email: string; password: string; inviteFailed?: boolean }[];
  failed: { name: string; email: string; reason: string }[];
}

/** Runs `fn` over `items` with at most `limit` in flight (the function has a 60 s budget). */
async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

Deno.serve(async (req) => {
  // What the destructive path has written so far (reported if it fails midway).
  const written = {
    wiped: false,
    tasksInserted: 0,
    commentsInserted: 0,
    specsInserted: 0,
    accounts: null as AccountsResult | null,
  };
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );

    // ── Permission floor: caller must be an admin/super_admin member ────────
    // The import wipes and rewrites tasks/sprints/comments — a plain member
    // JWT must never reach it. Same caller-role pattern as manage-member
    // (members.auth_id first, email fallback). A caller presenting the
    // service-role key itself (server-side scripting) is allowed through.
    let callerRole = 'super_admin';
    let callerName = '';
    let callerViaApiKey = false;
    {
      const authHeader = req.headers.get('Authorization') || '';
      const callerToken = authHeader.replace(/^Bearer\s+/i, '').trim();
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
      if (callerToken !== serviceKey) {
        if (!callerToken) return json({ error: 'Unauthorized' }, 401);
        const { data: { user: callerAuth }, error: callerErr } =
          await supabase.auth.getUser(callerToken);
        if (callerErr || !callerAuth) return json({ error: 'Invalid token' }, 401);
        type CallerRow = { role?: string; name?: string } | null;
        const { data: byAuth } = await supabase
          .from('members').select('role, name').eq('auth_id', callerAuth.id).maybeSingle();
        let caller = byAuth as CallerRow;
        if (!caller && callerAuth.email) {
          const { data: byEmail } = await supabase
            .from('members').select('role, name').eq('email', callerAuth.email).maybeSingle();
          caller = byEmail as CallerRow;
        }
        if (!caller?.role || !['admin', 'super_admin'].includes(caller.role)) {
          return json({ error: 'Permission denied: admin role required' }, 403);
        }
        callerRole = caller.role;
        callerName = caller.name || '';
        callerViaApiKey = isApiKeyToken(callerToken);
      }
    }

    // Tier behavior (contract C2): non-professional callers get a SAFE DRY-RUN.
    const license = await verifyLicense(supabase);
    const isPro = license.tier === 'professional';

    const request = await readImportRequest(req);
    if (!request) return json({ error: 'invalid_request', message: '請求格式不正確' }, 400);
    // Opening logins is refused to API keys (same rule as manage-member).
    if (callerViaApiKey && !request.dryRun && request.accounts.length > 0) {
      return json(API_KEY_FORBIDDEN, 403);
    }
    console.log('CSV length:', request.csv.length);

    const parsed = parseJiraExport(request.csv, { timeZone: request.timeZone });
    if (!parsed.ok) {
      if (parsed.error === 'no_data_rows') {
        return json({ error: 'no_data_rows', message: 'CSV 沒有任何資料列' }, 400);
      }
      return json(
        {
          error: 'missing_columns',
          message: `CSV 缺少必要欄位：${parsed.missing.map((m) => m.accepted.join(' / ')).join('、')}`,
          missingColumns: parsed.missing,
          detectedColumns: parsed.detected.slice(0, 500),
        },
        400,
      );
    }
    console.log('Parsed issues:', parsed.issues.length, 'people:', parsed.people.length);

    // ── Statuses: this install's own list (renamed / deleted / added ones
    //    included); every task gets the id of a status that exists. ──
    const { data: statusRows, error: statusErr } = await supabase
      .from('statuses').select('id, name, sort_order, is_done, auto_start');
    if (statusErr) throw new Error(`Load statuses failed: ${statusErr.message}`);
    const statusPlan = planStatuses(parsed.issues, (statusRows || []) as WorkspaceStatus[]);
    if (statusPlan.ok !== true) {
      return json({ error: 'no_statuses', message: '這個團隊還沒有任何任務狀態，請先到「狀態管理」新增' }, 400);
    }

    // ── People → members (plan only; nothing is written yet) ──
    const { data: existingMembersData, error: existingMembersErr } = await supabase
      .from('members')
      .select('id, name, email, role, is_active')
      .order('sort_order', { ascending: true })
      .order('id', { ascending: true });
    if (existingMembersErr) throw new Error(`Load members failed: ${existingMembersErr.message}`);
    const existing: ExistingMember[] = ((existingMembersData || []) as any[]).map((m) => ({
      id: m.id, name: m.name, email: m.email || '', role: m.role || 'member', isActive: m.is_active !== false,
    }));
    // Re-imports must not recycle already-taken uN ids.
    let memberCounter = 10;
    for (const m of existing) {
      const um = /^u(\d+)$/.exec(m.id);
      if (um) memberCounter = Math.max(memberCounter, parseInt(um[1], 10) + 1);
    }
    // Single-tenant install: every member is "this workspace".
    const emailOwners: Record<string, EmailOwner> = {};
    for (const m of existing) {
      if (isPlaceholderEmail(m.email)) continue;
      const key = normalizeEmail(m.email);
      if (!emailOwners[key]) emailOwners[key] = { memberId: m.id, name: m.name, sameWorkspace: true, hasLogin: true };
    }
    const memberPlan = planMembers({
      people: parsed.people,
      existing,
      accounts: request.accounts,
      emailOwners,
      callerIsSuperAdmin: callerRole === 'super_admin',
      newMemberId: () => `u${memberCounter++}`,
    });
    const personName = new Map(parsed.people.map((p) => [p.key, p.name]));
    // Fallback identity for rows with no resolvable reporter/creator: the
    // importing user (the legacy hardcoded 'u1' doesn't exist on fresh installs).
    const fallbackMemberId = await resolveImporterMemberId(supabase, req);
    const memberIdOf = (key: string | null): string | null => (key ? planMemberId(memberPlan.plans[key]) : null);
    const mention: MentionResolver = (accountId) => {
      const key = parsed.accountPeople[accountId];
      const name = key ? personName.get(key) : undefined;
      return name ? { name, memberId: memberIdOf(key) || '' } : null;
    };

    // ── Projects: one LIVO project per Jira project key. A project with the
    //    same key is reused (projects are not cleared, so a re-import lands in
    //    the same place); any other key becomes a new project named after the
    //    Jira project, created on the real-import path below. ──
    const { data: existingProjectsData, error: existingProjectsErr } = await supabase
      .from('projects').select('id, key');
    if (existingProjectsErr) throw new Error(`Load projects failed: ${existingProjectsErr.message}`);
    const projectIdByKey = new Map<string, string>();
    for (const p of (existingProjectsData || []) as { id: string; key: string }[]) {
      const k = (p.key || '').trim().toUpperCase();
      if (k && !projectIdByKey.has(k)) projectIdByKey.set(k, p.id);
    }
    const newProjects = new Map<string, { id: string; name: string; key: string }>();
    const projectIdFor = (rawKey: string, rawName: string): string => {
      const key = rawKey.trim().toUpperCase();
      const known = projectIdByKey.get(key);
      if (known) return known;
      const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
      const id = `jira-${slug}`;
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
      const createdAt = issue.created || today;
      for (const cm of issue.comments) {
        comments.push({
          id: `c${String(commentId++).padStart(5, '0')}`,
          task_id: issue.key,
          user_id: memberIdOf(cm.authorKey) || fallbackMemberId,
          content: textToHtml(cm.content, mention),
          created_at: cm.createdAt || createdAt,
        });
      }
      if (issue.description) {
        taskSpecs.push({
          id: `ts${String(specId++).padStart(5, '0')}`,
          task_id: issue.key,
          background: '',
          requirement: textToHtml(issue.description, mention),
          notes: '',
        });
      }
      tasks.push({
        id: issue.key,
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
    // Done-ness follows the status each task landed on.
    const doneTaskIds = new Set(tasks.filter((t) => statusPlan.isDone(t.status_id)).map((t) => t.id));
    // Exact (UTC) created / resolved instants for the sprint dates below.
    const instants = new Map(parsed.issues.map((i) => [i.key, { createdAt: i.createdAt, resolvedAt: i.resolvedAt }]));
    // Subtask links, applied after every task row exists (parent_task_id is a FK).
    const parentLinks = new Map<string, string[]>(); // parent task id → child task ids
    for (const issue of parsed.issues) {
      if (issue.parentKey) parentLinks.set(issue.parentKey, [...(parentLinks.get(issue.parentKey) || []), issue.key]);
    }

    const plans = Object.entries(memberPlan.plans);
    const loginChannel = await resolveLoginChannel(supabase, req);

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

    // ── Preview (dryRun, or contract C2 for non-pro): nothing written. ──
    if (!isPro || request.dryRun) {
      console.log('[import-jira] preview:', JSON.stringify({ ...stats, newMembers: stats.newMembers.length }));
      return json({
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
    // would otherwise cost the install its data.
    if (memberPlan.errors.length > 0) {
      return json(
        { error: 'account_errors', message: 'Email 對照表有問題，請修正後再匯入', accountErrors: memberPlan.errors },
        400,
      );
    }
    if (tasks.length === 0) {
      return json({ error: 'no_tasks', message: 'CSV 裡沒有可匯入的任務（每列都需要事務密鑰 / Issue key）', stats }, 400);
    }
    // Every target status must still exist right before the wipe (tasks.status_id is a FK).
    {
      const targetStatusIds = Array.from(new Set(tasks.map((t) => t.status_id)));
      const { data: present, error: presentErr } = await supabase.from('statuses').select('id').in('id', targetStatusIds);
      if (presentErr) throw new Error(`Check statuses failed: ${presentErr.message}`);
      const presentIds = new Set(((present || []) as { id: string }[]).map((r) => r.id));
      const missingStatuses = targetStatusIds.filter((id) => !presentIds.has(id));
      if (missingStatuses.length > 0) {
        return json(
          { error: 'status_missing', message: '要對應的任務狀態已不存在（可能剛被刪除），請重新預覽後再匯入', missingStatuses },
          409,
        );
      }
    }

    // ═══ Professional path: the real, DESTRUCTIVE import (writes begin here) ═══

    // ── Clear existing data (children before parents) ──
    console.log('Clearing existing data...');
    // Both approval and planning guards run before child writes in one transaction.
    const { error: clearError } = await supabase.rpc('livo_jira_clear_tasks');
    if (clearError) {
      const pending = clearError.message === 'approval_pending';
      const planning = clearError.message === 'planning_history_requires_restore';
      const work = clearError.message === 'work_history_requires_restore' || clearError.message === 'release_history_requires_restore';
      return json({ error: pending ? 'approval_pending' : planning ? 'planning_history_requires_restore' : work ? 'work_history_requires_restore' : 'import_clear_failed',
        message: pending ? '尚有簽核中的任務，請先撤回或完成簽核後再匯入。' : planning || work ?
          '此工作區保留任務操作歷史、期限異動或個人提醒設定，無法覆蓋匯入。請使用完整伺服器備份還原。' : '資料清除失敗，原資料已保留。' }, pending || planning || work ? 409 : 500);
    }
    written.wiped = true;
    // Steps after the wipe that may only warn (the data itself is in place).
    const warnings: string[] = [];

    // ── Create the projects this CSV introduces. Without these rows the
    //    tasks.project_id FK rejects every task insert. ──
    try {
      if (newProjects.size > 0) {
        const { data: lineRows } = await supabase
          .from('product_lines').select('id').order('sort_order', { ascending: true }).limit(1);
        let lineId = lineRows && lineRows[0]?.id;
        if (!lineId) {
          lineId = 'pl-import';
          const { error: lineErr } = await supabase
            .from('product_lines')
            .upsert({ id: lineId, name: '匯入' }, { onConflict: 'id', ignoreDuplicates: true });
          if (lineErr) throw new ImportStepError('projects', lineErr);
        }
        const projectRows = Array.from(newProjects.values()).map(p => ({
          id: p.id, line_id: lineId, name: p.name, key: p.key,
        }));
        const { error: projErr } = await supabase
          .from('projects')
          .upsert(projectRows, { onConflict: 'id', ignoreDuplicates: true });
        if (projErr) throw new ImportStepError('projects', projErr);
      }
    } catch (error) {
      throw error instanceof ImportStepError ? error : new ImportStepError('projects', error);
    }

    // ── Members. Name-only people first (as before) ──
    const nameOnly = plans
      .filter((e): e is [string, Extract<PersonPlan, { kind: 'new_name_only' }>] => e[1].kind === 'new_name_only')
      .map(([key, p]) => newMemberRow(p.memberId, personName.get(key) || key, placeholderEmail(p.memberId)));
    if (nameOnly.length > 0) {
      console.log('Creating name-only members:', nameOnly.length);
      const { error } = await supabase.from('members').insert(nameOnly);
      if (error) throw new ImportStepError('members', error);
    }

    // ── …then the people on the accounts list: GoTrue user → member row →
    //    invitation / temporary password. A failure keeps the person as a
    //    name-only member so their tasks still import. ──
    const accountsResult: AccountsResult = { method: loginChannel.method, invited: [], credentials: [], failed: [] };
    written.accounts = accountsResult;
    let memberFallbackError: unknown = null;
    const accountPlans = plans.filter((e): e is [string, AccountPlan] => e[1].kind === 'new_account' || e[1].kind === 'activate');
    if (accountPlans.length > 0) {
      const authUsers = await loadAuthUsersByEmail(supabase);
      await mapLimit(accountPlans, 4, async ([key, p]) => {
        const name = personName.get(key) || key;
        let login = null;
        let memberWritten = false;
        try {
          login = await prepareLogin(supabase, loginChannel.method, { email: p.email, name }, authUsers);
          const { error: memberErr } = p.kind === 'new_account'
            ? await supabase.from('members').insert({ ...newMemberRow(p.memberId, name, p.email), auth_id: login.authUserId })
            : await supabase.from('members').update({ email: p.email, auth_id: login.authUserId }).eq('id', p.memberId);
          if (memberErr) throw new Error(memberErr.message);
          memberWritten = true;
          const delivery = await deliverLogin(supabase, loginChannel, login, { name, email: p.email, invitedBy: callerName });
          if (delivery.method === 'invite') accountsResult.invited.push({ name, email: p.email });
          else {
            accountsResult.credentials.push({
              name, email: p.email, password: delivery.tempPassword || '',
              ...(delivery.inviteFailed ? { inviteFailed: true } : {}),
            });
          }
        } catch (error) {
          console.error('Create login error:', name, error);
          if (memberWritten) {
            // The member points at this login now (members.auth_id): keep both;
            // only the invitation / password step failed.
            accountsResult.failed.push({ name, email: p.email, reason: 'delivery_failed' });
            return;
          }
          if (login) await discardLogin(supabase, login, authUsers);
          accountsResult.failed.push({ name, email: p.email, reason: error instanceof LoginError ? 'email_taken' : 'create_failed' });
          if (p.kind === 'new_account') {
            const { error: fallbackErr } = await supabase
              .from('members').insert(newMemberRow(p.memberId, name, placeholderEmail(p.memberId)));
            if (fallbackErr) {
              console.error('Insert fallback member error:', fallbackErr);
              memberFallbackError = fallbackErr;
            }
          }
        }
      });
    }

    // Without the member row every task that points at this person would fail.
    if (memberFallbackError) throw new ImportStepError('members', memberFallbackError);

    // ── Insert sprints. On failure, drop the mapping AND detach the tasks that
    //    referenced the now-missing sprints. ──
    if (sprintMap.size > 0) {
      const sprintRows = Array.from(sprintMap.entries()).map(([name, id]) => ({
        id,
        name,
        is_active: false,
        completed_at: new Date().toISOString(),
        completed_count: 0,
        pending_count: 0,
      }));
      const { error } = await supabase.from('sprints').insert(sprintRows);
      if (error) {
        console.error('Insert sprint error:', error);
        warnings.push('sprints');
        sprintMap.clear(); // failed sprints must not be referenced by tasks
        for (const t of tasks) t.sprint_id = null;
      }
    }
    console.log('Created sprints:', Array.from(sprintMap.keys()));

    console.log(`Inserting ${tasks.length} tasks, ${comments.length} comments, ${taskSpecs.length} specs`);

    // Insert tasks in batches of 50, then comments (100) and specs (50). A
    // failed batch stops the import (import_failed) instead of being skipped,
    // so a half-written import is never reported as done.
    for (let i = 0; i < tasks.length; i += 50) {
      const batch = tasks.slice(i, i + 50);
      const { error } = await supabase.from('tasks').insert(batch);
      if (error) {
        console.error(`Insert tasks batch ${i} error:`, error, 'First task:', JSON.stringify(batch[0]));
        throw new ImportStepError('tasks', error);
      }
      written.tasksInserted += batch.length;
    }
    for (let i = 0; i < comments.length; i += 100) {
      const batch = comments.slice(i, i + 100);
      const { error } = await supabase.from('comments').insert(batch);
      if (error) throw new ImportStepError('comments', error);
      written.commentsInserted += batch.length;
    }
    for (let i = 0; i < taskSpecs.length; i += 50) {
      const batch = taskSpecs.slice(i, i + 50);
      const { error } = await supabase.from('task_specs').insert(batch);
      if (error) throw new ImportStepError('specs', error);
      written.specsInserted += batch.length;
    }

    // ── Subtasks: parent_task_id, now that every task row exists ──
    let subtasksLinked = 0;
    for (const [parentId, childIds] of parentLinks) {
      for (let i = 0; i < childIds.length; i += 100) {
        const chunk = childIds.slice(i, i + 100);
        const { error } = await supabase.from('tasks').update({ parent_task_id: parentId } as any).in('id', chunk);
        if (error) throw new ImportStepError('subtasks', error);
        subtasksLinked += chunk.length;
      }
    }

    // ── Post-insert: set department based on member job_titles ──
    try {
      const { data: memberRows } = await supabase.from('members').select('id, name, job_title');
      if (memberRows) {
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
        for (const [memberId, dept] of memberDeptMap) {
          await supabase.from('tasks').update({ department: dept } as any).eq('assignee_id', memberId).is('department', null);
        }
        console.log(`Set departments for ${memberDeptMap.size} members`);
      }
    } catch (error) {
      console.error('Set departments error:', error);
      warnings.push('departments');
    }

    // Update sprint dates and counts from task data
    // started_at = earliest created_at of tasks in this sprint
    // completed_at = latest completed_at of tasks in this sprint
    try {
      for (const sprintId of sprintMap.values()) {
        const sprintTasks = tasks.filter(t => t.sprint_id === sprintId);
        const completedCount = sprintTasks.filter(t => doneTaskIds.has(t.id)).length;
        const pendingCount = sprintTasks.length - completedCount;

        // started_at: earliest creation among tasks in this sprint (exact
        // UTC instant when the export had a time, else the calendar date)
        const createdDates = sprintTasks
          .map(t => new Date(instants.get(t.id)?.createdAt || t.created_at).getTime())
          .filter(ts => !isNaN(ts));
        const minCreated = createdDates.length > 0 ? new Date(Math.min(...createdDates)) : null;

        // completed_at: latest resolution among tasks in this sprint
        const completedDates = sprintTasks
          .filter(t => t.completed_at)
          .map(t => new Date(instants.get(t.id)?.resolvedAt || (t.completed_at as string)).getTime())
          .filter(ts => !isNaN(ts));
        const maxCompleted = completedDates.length > 0 ? new Date(Math.max(...completedDates)) : null;

        await supabase.from('sprints').update({
          completed_count: completedCount,
          pending_count: pendingCount,
          ...(maxCompleted ? { completed_at: maxCompleted.toISOString() } : {}),
          ...(minCreated ? { started_at: minCreated.toISOString() } : {}),
        } as any).eq('id', sprintId);
      }
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

      const { error: activeErr } = await supabase.from('sprints').insert({
        id: activeSprintId, name: activeSprintName, is_active: true,
      });
      if (activeErr) {
        console.error('Create active sprint error:', activeErr);
        warnings.push('active_sprint');
      } else {
        // Move all uncompleted tasks to the active sprint
        const uncompletedTaskIds = tasks.filter(t => !doneTaskIds.has(t.id)).map(t => t.id);

        if (uncompletedTaskIds.length > 0) {
          for (let i = 0; i < uncompletedTaskIds.length; i += 100) {
            const chunk = uncompletedTaskIds.slice(i, i + 100);
            const { error } = await supabase.from('tasks').update({ sprint_id: activeSprintId } as any).in('id', chunk);
            if (error) {
              console.error('Move tasks to active sprint error:', error);
              warnings.push('active_sprint');
            }
          }
        }
        console.log(`Created active sprint "${activeSprintName}" with ${uncompletedTaskIds.length} uncompleted tasks`);
      }
    } catch (error) {
      console.error('Create active sprint error:', error);
      warnings.push('active_sprint');
    }

    return json({
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
      warnings: Array.from(new Set(warnings)),
    });
  } catch (err) {
    console.error('Import error:', err);
    if (written.wiped) {
      // The wipe ran but the import did not finish: say so, with what landed
      // and any logins already created (their temporary passwords included).
      return json({
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
      }, 500);
    }
    return json({ error: String(err) }, 500);
  }
});
