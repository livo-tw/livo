import { taskWorkMockCommand, workMockMoveSubtasks, workMockPatch } from './taskWorkMock';
import { TaskWorkError, taskWorkError } from '@/lib/taskWork/core';
import { mockApprovalCommand } from './mockApprovalCommands';
// Mock Supabase Client for local development without Docker/Supabase
// Stores all data in-memory. Pre-seeded with statuses, members, and demo data.

import { seedAllDemoData } from './seedData';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { seedKnowledgeMock, knowledgeMockDefaults, knowledgeMockUpdate } from './knowledgeMock';
import { knowledgeWorkMock, knowledgeMockVisible, knowledgeMockWriteGuard, knowledgeMockRestoreAvailable, knowledgeMockHasData, knowledgeMockForgetDeleted } from './knowledgeWorkMock';
import { KnowledgeWorkError, knowledgeWorkError } from '@/lib/knowledgeWork/core';
import { planningMockActor, planningMockRpc, planningMockUpdate, planningMockSuppressed } from './taskPlanningMock';
import { TaskPlanningError, calendarDate, dueDateKind } from '@/lib/taskPlanning/core';

// ─── Types ───────────────────────────────────────────────────────────────

interface AuthUser { id: string; email: string; }
interface AuthSession { user: AuthUser; access_token: string; refresh_token?: string; }

/** A single row in any in-memory table. */
type DbRow = Record<string, unknown>;

/** Supported filter value types for mock query builders. */
type FilterValue = string | number | boolean | null | undefined | unknown[];

type ThenableResult = { data: unknown; error: { message: string } | null; count?: number | null };

// ─── In-memory stores ────────────────────────────────────────────────────

const db: Record<string, DbRow[]> = {};

// All 20 members can login with password test1234
const AUTH_CREDENTIALS: Record<string, { password: string; authId: string }> = {};

let currentSession: AuthSession | null = null;
const demoSlackLink = { disabled: false, mode: 'email' as const, linked: null as null };
const authListeners: Array<(event: string, session: AuthSession | null) => void> = [];

// ─── 20 Team Members ────────────────────────────────────────────────────

const MEMBERS = [
  // ── Management ──
  { id: 'm-001',  name: '王建宏',   avatar: '建宏', role: 'super_admin', job_title: 'CEO / 產品總監', color: '#FF5630', email: 'jianhong@livo.test',  sort_order: 0 },
  { id: 'm-002',  name: '陳雅琪',   avatar: '雅琪', role: 'admin',       job_title: 'PM Lead',         color: '#6554C0', email: 'yaqi@livo.test',      sort_order: 1 },
  // ── PM ──
  { id: 'm-003',  name: '林佳蓉',   avatar: '佳蓉', role: 'admin',       job_title: 'PM — 遊戲產線',   color: '#FF8B00', email: 'jiarong@livo.test',   sort_order: 2 },
  { id: 'm-004',  name: '黃心怡',   avatar: '心怡', role: 'admin',       job_title: 'PM — 電商產線',   color: '#00B8D9', email: 'xinyi@livo.test',     sort_order: 3 },
  // ── Design ──
  { id: 'm-005',  name: '張靜如',   avatar: '靜如', role: 'member',      job_title: 'UI/UX Lead',      color: '#FFC400', email: 'jingru@livo.test',    sort_order: 4 },
  { id: 'm-006',  name: '劉宇涵',   avatar: '宇涵', role: 'member',      job_title: 'UI Designer',     color: '#998DD9', email: 'yuhan@livo.test',     sort_order: 5 },
  // ── Frontend ──
  { id: 'm-007',  name: '許文傑',   avatar: '文傑', role: 'member',      job_title: 'FE Lead',         color: '#36B37E', email: 'wenjie@livo.test',    sort_order: 6 },
  { id: 'm-008',  name: '鄭志豪',   avatar: '志豪', role: 'member',      job_title: 'FE — React',      color: '#4C9AFF', email: 'zhihao@livo.test',    sort_order: 7 },
  { id: 'm-009',  name: '蔡明軒',   avatar: '明軒', role: 'member',      job_title: 'FE — Vue',        color: '#79E2F2', email: 'mingxuan@livo.test',  sort_order: 8 },
  { id: 'm-010',  name: '吳佩珊',   avatar: '佩珊', role: 'member',      job_title: 'FE — Mobile',     color: '#B3D4FF', email: 'peishan@livo.test',   sort_order: 9 },
  // ── Backend ──
  { id: 'm-011',  name: '李承恩',   avatar: '承恩', role: 'member',      job_title: 'BE Lead',         color: '#0065FF', email: 'chengen@livo.test',   sort_order: 10 },
  { id: 'm-012',  name: '周冠宇',   avatar: '冠宇', role: 'member',      job_title: 'BE — Java',       color: '#403294', email: 'guanyu@livo.test',    sort_order: 11 },
  { id: 'm-013',  name: '楊家瑋',   avatar: '家瑋', role: 'member',      job_title: 'BE — Node.js',    color: '#00875A', email: 'jiawei@livo.test',    sort_order: 12 },
  { id: 'm-014',  name: '趙柏翰',   avatar: '柏翰', role: 'member',      job_title: 'BE — Python/ML',  color: '#5243AA', email: 'bohan@livo.test',     sort_order: 13 },
  // ── SRE / DevOps ──
  { id: 'm-015',  name: '謝宗霖',   avatar: '宗霖', role: 'member',      job_title: 'SRE Lead',        color: '#172B4D', email: 'zonglin@livo.test',   sort_order: 14 },
  { id: 'm-016',  name: '廖俊傑',   avatar: '俊傑', role: 'member',      job_title: 'DevOps',          color: '#505F79', email: 'junjie@livo.test',    sort_order: 15 },
  // ── QA ──
  { id: 'm-017',  name: '蘇怡婷',   avatar: '怡婷', role: 'member',      job_title: 'QA Lead',         color: '#FF8F73', email: 'yiting@livo.test',    sort_order: 16 },
  { id: 'm-018',  name: '葉家銘',   avatar: '家銘', role: 'member',      job_title: 'QA Engineer',     color: '#FFAB00', email: 'jiaming@livo.test',   sort_order: 17 },
  // ── Data ──
  { id: 'm-019',  name: '鄧雅文',   avatar: '雅文', role: 'member',      job_title: 'Data Analyst',    color: '#C1C7D0', email: 'yawen@livo.test',     sort_order: 18 },
  { id: 'm-020',  name: '方彥廷',   avatar: '彥廷', role: 'member',      job_title: 'Data Engineer',   color: '#8993A4', email: 'yanting@livo.test',   sort_order: 19 },
];

// Build auth credentials for all members
MEMBERS.forEach(m => {
  AUTH_CREDENTIALS[m.email] = { password: 'test1234', authId: `auth-${m.id}` };
});
// Admin alias — admin@livo.test logs in as the super_admin (m-001)
AUTH_CREDENTIALS['admin@livo.test'] = { password: 'test1234', authId: 'auth-m-001' };

function initializeData() {
  // ── Statuses ──
  db['statuses'] = [
    { id: 's1', name: '待辦',     color: '#6B778C', sort_order: 1, is_done: false, auto_start: false, auto_done: false },
    { id: 's2', name: '正在進行', color: '#0065FF', sort_order: 2, is_done: false, auto_start: true,  auto_done: false },
    { id: 's3', name: '待驗收',   color: '#FF8B00', sort_order: 3, is_done: false, auto_start: false, auto_done: false },
    { id: 's4', name: '待討論確認', color: '#6554C0', sort_order: 4, is_done: false, auto_start: false, auto_done: false },
    { id: 's5', name: '等待部署', color: '#00B8D9', sort_order: 5, is_done: false, auto_start: false, auto_done: false },
    { id: 's6', name: '完成',     color: '#36B37E', sort_order: 6, is_done: true,  auto_start: false, auto_done: true  },
    { id: 's7', name: '不做了',   color: '#97A0AF', sort_order: 7, is_done: true,  auto_start: false, auto_done: true  },
  ];

  // ── Members (20 people) ──
  db['members'] = MEMBERS.map(m => ({
    ...m, is_active: true, auth_id: `auth-${m.id}`,
  }));

  // ── Initialize all empty tables ──
  for (const t of [
    'product_lines','projects','tasks','task_deployments','task_specs',
    'task_checks','task_todos','comments','status_logs','notifications',
    'sprints','activity_logs','member_manuals','backup_settings',
    'backup_history','task_attachments','user_column_configs','profiles',
    'tags','task_tags','task_dependencies','task_reminder_preferences','task_deadline_history',
  ]) {
    if (!db[t]) db[t] = [];
  }

  // ── Populate all demo data via seedData ──
  seedAllDemoData(db);
  // Seeded tasks get the responsibility columns the real tasks table defaults.
  for (const task of db['tasks']) {
    task.assignee_revision ??= 0; task.reviewer_revision ??= 0;
    task.assignee_acknowledged_at ??= null; task.reviewer_acknowledged_at ??= null;
  }
  db['system_settings'] = [{ key: 'feature_toggles', value: { approvals: true }, updated_at: new Date().toISOString() }];
  seedKnowledgeMock(db);

  // Restore auth session.
  // In ?demo=pro sales mode we auto-sign-in as a real seeded super_admin
  // (jianhong, m-001) purely in-memory — NO localStorage write, so the
  // session dies with the tab and never leaks to a real visitor.
  if (IS_DEMO_PRO) {
    currentSession = {
      user: { id: 'auth-m-001', email: 'jianhong@livo.test' },
      access_token: 'demo-pro-session',
    };
  } else {
    try {
      const saved = localStorage.getItem('mock-auth-session');
      if (saved) currentSession = JSON.parse(saved);
    } catch (_err: unknown) {
      // localStorage parse failure — ignore
    }
  }
}

initializeData();

// ─── Helpers ─────────────────────────────────────────────────────────────

function clone<T>(o: T): T { return JSON.parse(JSON.stringify(o)); }

function uuid(): string {
  return crypto.randomUUID
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
}

type Filter = { col: string; op: string; val: FilterValue };

/**
 * Comparison filters with SQL NULL semantics, as PostgREST and the D1 worker
 * apply them: a NULL on either side never matches. Timestamps are uniform
 * toISOString() strings, so string order is chronological order.
 */
function compare(v: unknown, op: string, val: unknown): boolean {
  if (v == null || val == null) return false;
  const a = v as string | number;
  const b = val as string | number;
  switch (op) {
    case 'neq': return a !== b;
    case 'gt':  return a > b;
    case 'gte': return a >= b;
    case 'lt':  return a < b;
    case 'lte': return a <= b;
    default:    throw new Error(`mockClient: unsupported filter "${op}"`);
  }
}

function matchOp(v: unknown, op: string, val: FilterValue): boolean {
  switch (op) {
    case 'eq': return v === val;
    case 'in': return Array.isArray(val) && val.includes(v);
    case 'is': return val === null ? v == null : v === val;
    default:   return compare(v, op, val);
  }
}

/**
 * PostgREST or-expression: comma-joined `col.op.value` with the ops the D1
 * worker accepts (eq|neq|is|gt|gte|lt|lte), e.g. 'project_id.eq.X,project_id.is.null'.
 */
function matchesOr(row: DbRow, expr: string): boolean {
  return expr.split(',').map(s => s.trim()).filter(Boolean).some(part => {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\.(eq|neq|is|gt|gte|lt|lte)\.([\s\S]*)$/.exec(part);
    if (!m) throw new Error(`mockClient: unsupported or() condition "${part}"`);
    const [, col, op, raw] = m;
    const v = row[col];
    if (op === 'is') {
      if (raw !== 'null' && raw !== 'true' && raw !== 'false') {
        throw new Error(`mockClient: unsupported or() condition "${part}"`);
      }
      return matchOp(v, 'is', raw === 'null' ? null : raw === 'true');
    }
    // The expression is text; read the value the way the column stores it.
    const val = typeof v === 'number' ? Number(raw) : typeof v === 'boolean' ? raw === 'true' : raw;
    return matchOp(v, op, val);
  });
}

function matches(row: DbRow, filters: Filter[]): boolean {
  return filters.every(f => {
    if (f.op === 'or') return matchesOr(row, f.val as string);
    const v = row[f.col];
    if (!f.op.startsWith('not-')) return matchOp(v, f.op, f.val);
    // NOT(NULL) is still NULL in SQL, so only `not.is` can match a NULL column.
    const op = f.op.slice('not-'.length);
    return (op === 'is' || v != null) && !matchOp(v, op, f.val);
  });
}

function tbl(name: string): DbRow[] {
  if (!db[name]) db[name] = [];
  return db[name];
}

/** Fills the columns the DB defaults on INSERT; shared by insert() and upsert(). */
function withInsertDefaults(t: string, row: DbRow): DbRow {
  if (!row.id) row.id = uuid();
  if (!row.created_at) row.created_at = new Date().toISOString();
  if (!row.started_at && t === 'sprints') row.started_at = new Date().toISOString();
  if (t==='tasks') { row.due_date=calendarDate(row.due_date??null); row.due_date_kind=dueDateKind(row.due_date_kind??null); if(!row.due_date && row.due_date_kind) throw new TaskPlanningError('planning_date_required'); row.due_date_kind ??= null; row.due_date_version=0; row.due_date_change_reason=null; row.due_date_changed_by=null; }
  return knowledgeMockDefaults(t, workMockPatch(db,t,null,row));
}

function withWorkTaskUpdate(before:DbRow,patch:DbRow,actor:string) {
  const work=workMockPatch(db,'tasks',before,patch),changed=planningMockUpdate(before,patch,actor,db);
  for(const key of ['assignee_revision','reviewer_revision','assignee_acknowledged_at','reviewer_acknowledged_at'])changed.row[key]=work[key];
  return changed;
}

// ─── MockQuery ───────────────────────────────────────────────────────────
// Base of every builder. Awaiting it (or calling .then) runs the query against
// the in-memory tables and settles a real promise, so callbacks run async and
// `.then(...).catch(...)` chains work as with supabase-js. `.single()` /
// `.maybeSingle()` shape the rows for reads and writes alike.

abstract class MockQuery {
  private _single = false;
  private _maybe = false;
  /** select('*', { count: 'exact', head }): the number of matching rows, before any limit. */
  protected countRequest: { head: boolean } | null = null;
  protected matchedCount = 0;

  /** Runs against the in-memory tables; returns the rows read or written. */
  protected abstract run(): DbRow[];

  single()      { this._single = true; return this; }
  maybeSingle() { this._maybe = true; return this; }

  then<A = ThenableResult, B = never>(
    ok?: ((res: ThenableResult) => A | PromiseLike<A>) | null,
    fail?: ((e: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return new Promise<ThenableResult>((resolve,reject) => { try { resolve(this.respond(this.run())); } catch(e) { if(e instanceof TaskPlanningError || e instanceof TaskWorkError || e instanceof KnowledgeWorkError) resolve({data:null,error:{message:e.code}}); else reject(e); } }).then(ok, fail);
  }

  private respond(rows: DbRow[]): ThenableResult {
    if (this.countRequest) return { data: this.countRequest.head ? null : rows, error: null, count: this.matchedCount };
    if (this._single) {
      return rows.length ? { data: rows[0], error: null } : { data: null, error: { message: 'No rows found' } };
    }
    if (this._maybe) return { data: rows[0] || null, error: null };
    return { data: rows, error: null };
  }
}

// ─── InsertBuilder ───────────────────────────────────────────────────────

class InsertBuilder extends MockQuery {
  private t: string;
  private rows: DbRow[];

  constructor(t: string, data: DbRow | DbRow[]) {
    super();
    this.t = t;
    this.rows = Array.isArray(data) ? data : [data];
  }

  /** Writes always resolve with their rows here; .select() is accepted for parity. */
  select(_cols?: string) { return this; }

  protected run(): DbRow[] {
    if(this.t.startsWith('task_work_'))throw new TaskWorkError('work_forbidden');
    if (['task_deadline_history','task_reminder_preferences'].includes(this.t)) throw new TaskPlanningError('planning_forbidden');
    const arr = tbl(this.t);
    const inserted: DbRow[] = [];
    for (const r of this.rows) {
      knowledgeMockWriteGuard(db,currentSession?.user.id,this.t,null,r);
      const row = withInsertDefaults(this.t, clone(r));
      if(this.t==='notifications' && planningMockSuppressed(db,row)) continue;
      arr.push(row);
      inserted.push(row);
    }
    return inserted;
  }
}

// ─── FilterBuilder ───────────────────────────────────────────────────────
// select / update / delete share supabase-js's filter surface, as the real
// client and cfClient do, so a filter the app uses on any kind of query can't
// throw "x is not a function" in demo mode only.

abstract class FilterBuilder extends MockQuery {
  protected filters: Filter[] = [];

  private add(col: string, op: string, val: FilterValue): this {
    this.filters.push({ col, op, val });
    return this;
  }

  eq(c: string, v: FilterValue)  { return this.add(c, 'eq',  v); }
  neq(c: string, v: FilterValue) { return this.add(c, 'neq', v); }
  gt(c: string, v: FilterValue)  { return this.add(c, 'gt',  v); }
  gte(c: string, v: FilterValue) { return this.add(c, 'gte', v); }
  lt(c: string, v: FilterValue)  { return this.add(c, 'lt',  v); }
  lte(c: string, v: FilterValue) { return this.add(c, 'lte', v); }
  is(c: string, v: FilterValue)  { return this.add(c, 'is',  v); }
  in(c: string, v: unknown[])    { return this.add(c, 'in',  v); }
  not(c: string, op: string, v: FilterValue) { return this.add(c, `not-${op}`, v); }
  /** PostgREST or-expression, e.g. 'project_id.eq.X,project_id.is.null'. */
  or(expr: string) { return this.add('', 'or', expr); }
}

// ─── SelectBuilder ───────────────────────────────────────────────────────

class SelectBuilder extends FilterBuilder {
  private t: string;
  private cols: string[] | null;
  private _order: { col: string; asc: boolean } | null = null;
  private _limit: number | null = null;
  private _offset=0;

  constructor(t: string, cols?: string, opts?: { count?: string; head?: boolean }) {
    super();
    this.t = t;
    this.cols = cols && cols !== '*' ? cols.split(',').map(s => s.trim()) : null;
    if (opts?.count) this.countRequest = { head: !!opts.head };
  }

  order(col: string, opts?: { ascending?: boolean }) {
    this._order = { col, asc: opts?.ascending !== false };
    return this;
  }
  limit(n: number) { this._limit = n; return this; }
  range(from:number,to:number) { this._offset=from; this._limit=to-from+1; return this; }

  protected run(): DbRow[] {
    if(['task_work_receipts','task_work_contexts','task_work_internal_versions'].includes(this.t))throw new TaskWorkError('work_forbidden');
    let rows = clone(tbl(this.t)).filter(r => matches(r, this.filters));
    if(this.t.startsWith('kb_')||this.t==='field_locks')rows=rows.filter(r=>knowledgeMockVisible(db,currentSession?.user.id,this.t,r));
    if(this.t==='task_reminder_preferences') { const actor=planningMockActor(db,currentSession?.user.id); rows=rows.filter(r=>r.member_id===actor); }
    if (this._order) {
      const { col, asc } = this._order;
      rows.sort((a: DbRow, b: DbRow) => {
        if ((a[col] as number) < (b[col] as number)) return asc ? -1 : 1;
        if ((a[col] as number) > (b[col] as number)) return asc ? 1 : -1;
        return 0;
      });
    }
    this.matchedCount = rows.length;
    if (this._offset || this._limit!==null) rows = rows.slice(this._offset,this._limit===null?undefined:this._offset+this._limit);
    if (this.cols) {
      rows = rows.map((r: DbRow) => {
        const o: DbRow = {};
        this.cols!.forEach(k => o[k] = r[k]);
        return o;
      });
    }
    return rows;
  }
}

// ─── UpdateBuilder ───────────────────────────────────────────────────────

class UpdateBuilder extends FilterBuilder {
  private t: string;
  private vals: DbRow;

  constructor(t: string, vals: DbRow) { super(); this.t = t; this.vals = vals; }

  /** Writes always resolve with their rows here; .select() is accepted for parity. */
  select(_cols?: string) { return this; }

  protected run(): DbRow[] {
    const arr = tbl(this.t);
    const updated: DbRow[] = [];
    if(this.t.startsWith('task_work_'))throw new TaskWorkError('work_forbidden');
    if (['task_deadline_history','task_reminder_preferences'].includes(this.t)) throw new TaskPlanningError('planning_forbidden');
    if (this.t==='tasks') {
      const actor=planningMockActor(db,currentSession?.user.id);
      const prepared=arr.map((r,i)=>matches(r,this.filters)?{i,...withWorkTaskUpdate(r,clone(this.vals),actor)}:null).filter(x=>x!==null);
      const before=arr.slice();
      // Moved parents take their subtasks along; any refused subtask rolls the whole update back.
      try { for(const change of prepared) arr[change.i]=change.row; for(const change of prepared) workMockMoveSubtasks(db,before[change.i],change.row); }
      catch(error) { arr.splice(0,arr.length,...before); throw error; }
      for(const change of prepared) { updated.push(change.row); if(change.history) tbl('task_deadline_history').push(change.history); }
      return updated;
    }
    arr.forEach((row, i) => {
      if (matches(row, this.filters)) {
        knowledgeMockWriteGuard(db,currentSession?.user.id,this.t,row,this.vals);
        arr[i] = this.t === 'kb_pages' ? knowledgeMockUpdate(db, row, clone(this.vals)) : workMockPatch(db,this.t,row,clone(this.vals));
        updated.push(arr[i]);
      }
    });
    return updated;
  }
}

// ─── DeleteBuilder ───────────────────────────────────────────────────────

class DeleteBuilder extends FilterBuilder {
  private t: string;

  constructor(t: string) { super(); this.t = t; }

  /** Writes always resolve with their rows here; .select() is accepted for parity. */
  select(_cols?: string) { return this; }

  protected run(): DbRow[] {
    const arr = tbl(this.t);
    if(this.t.startsWith('task_work_'))throw new TaskWorkError('work_forbidden');
    if (['task_deadline_history','task_reminder_preferences'].includes(this.t)) throw new TaskPlanningError('planning_forbidden');
    if(['tasks','members','projects','comments','checks','todos','task_specs','task_attachments','qa_issues'].includes(this.t) && !this.filters.some(f=>f.op==='eq'||f.op==='in') && knowledgeMockHasData(db)) throw new KnowledgeWorkError('knowledge_requires_server_restore',409);
    const deleted: DbRow[] = [];
    for (let i = arr.length - 1; i >= 0; i--) {
      if (matches(arr[i], this.filters)) {knowledgeMockWriteGuard(db,currentSession?.user.id,this.t,arr[i],{});const [row]=arr.splice(i, 1);deleted.push(row);knowledgeMockForgetDeleted(db,this.t,row);}
    }
    return deleted;
  }
}

// ─── UpsertBuilder ───────────────────────────────────────────────────────
// upsert() still writes immediately, as before; this only lets callers chain
// .select() / .single() and await the written rows like a real builder.

class UpsertBuilder extends MockQuery {
  private rows: DbRow[];

  constructor(rows: DbRow[]) { super(); this.rows = rows; }

  select(_cols?: string) { return this; }

  protected run(): DbRow[] { return this.rows; }
}

// ─── Table Reference ─────────────────────────────────────────────────────

// upsert() without onConflict conflicts on the primary key, as in PostgREST and
// the D1 worker. Tables the app upserts whose primary key isn't `id`
// (worker/src/tables.ts):
const PRIMARY_KEYS: Record<string, string> = {
  system_settings: 'key',
  team_settings: 'key',
  user_notification_preferences: 'user_id',
};

class TableRef {
  private t: string;
  constructor(t: string) { this.t = t; }

  select(cols?: string, opts?: { count?: string; head?: boolean }) { return new SelectBuilder(this.t, cols, opts); }
  insert(data: DbRow | DbRow[]) { return new InsertBuilder(this.t, data); }
  update(vals: DbRow)   { return new UpdateBuilder(this.t, vals); }
  delete()              { return new DeleteBuilder(this.t); }

  /**
   * A row whose conflict columns (onConflict, else the primary key) equal an
   * existing row's is merged into that row, which keeps its id; any other row
   * is inserted. NULL never conflicts, as in a SQL unique index.
   * ignoreDuplicates skips a conflicting row instead (ON CONFLICT DO NOTHING),
   * leaving it out of the result.
   */
  upsert(data: DbRow | DbRow[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
    if(this.t.startsWith('kb_'))throw new KnowledgeWorkError('knowledge_forbidden');
    if(this.t.startsWith('task_work_'))throw new TaskWorkError('work_forbidden');
    if (['task_deadline_history','task_reminder_preferences'].includes(this.t)) throw new TaskPlanningError('planning_forbidden');
    const keys = opts?.onConflict
      ? opts.onConflict.split(',').map(s => s.trim())
      : [PRIMARY_KEYS[this.t] ?? 'id'];
    const arr = tbl(this.t);
    const result: DbRow[] = [];
    for (const r of Array.isArray(data) ? data : [data]) {
      const row = clone(r);
      const idx = keys.every(k => row[k] != null)
        ? arr.findIndex(x => keys.every(k => x[k] === row[k]))
        : -1;
      if (idx < 0) {
        arr.push(withInsertDefaults(this.t, row));
        result.push(row);
      } else if (!opts?.ignoreDuplicates) {
        if(this.t==='tasks') {
          const change=withWorkTaskUpdate(arr[idx],row,planningMockActor(db,currentSession?.user.id)),before=arr.slice();
          try { arr[idx]=change.row; workMockMoveSubtasks(db,before[idx],change.row); } catch(error) { arr.splice(0,arr.length,...before); throw error; }
          if(change.history) tbl('task_deadline_history').push(change.history);
        }
        else arr[idx] = workMockPatch(db,this.t,arr[idx],{...row,id:arr[idx].id});
        result.push(arr[idx]);
      }
    }
    return new UpsertBuilder(result);
  }
}

// ─── Auth ────────────────────────────────────────────────────────────────

class MockAuth {
  async signInWithPassword(creds: { email: string; password: string }) {
    const entry = AUTH_CREDENTIALS[creds.email];
    if (!entry || entry.password !== creds.password) {
      return { data: { user: null, session: null }, error: { message: '帳號或密碼錯誤' } };
    }
    const session: AuthSession = {
      user: { id: entry.authId, email: creds.email },
      access_token: `mock-token-${entry.authId}`,
    };
    currentSession = session;
    localStorage.setItem('mock-auth-session', JSON.stringify(session));
    setTimeout(() => authListeners.forEach(fn => fn('SIGNED_IN', session)), 0);
    return { data: { user: session.user, session }, error: null };
  }

  async signOut() {
    currentSession = null;
    localStorage.removeItem('mock-auth-session');
    authListeners.forEach(fn => fn('SIGNED_OUT', null));
    return { error: null };
  }

  async getUser() {
    return { data: { user: currentSession?.user ?? null }, error: null };
  }

  async getSession() {
    return { data: { session: currentSession ?? null }, error: null };
  }

  onAuthStateChange(cb: (event: string, session: AuthSession | null) => void) {
    authListeners.push(cb);
    return {
      data: {
        subscription: {
          unsubscribe() {
            const i = authListeners.indexOf(cb);
            if (i > -1) authListeners.splice(i, 1);
          },
        },
      },
    };
  }

  async setSession(_tokens: { access_token?: string; refresh_token?: string }) {
    return { data: { session: currentSession }, error: null };
  }

  async signInWithOAuth() {
    return { error: { message: 'OAuth not available in local mode' } };
  }
}

// ─── Functions (Edge Functions mock) ─────────────────────────────────────

interface ManageMemberBody {
  action: string;
  name?: string;
  avatar?: string;
  role?: string;
  jobTitle?: string;
  color?: string;
  email?: string;
  memberId?: string;
  isActive?: boolean;
}

class MockFunctions {
  async invoke(fnName: string, opts?: { body?: Record<string, unknown> }) {
    const body = opts?.body || {};
    if(fnName==='knowledge-restore-check'){try{return {data:{available:knowledgeMockRestoreAvailable(db,currentSession?.user.id)},error:null};}catch(error){return {data:null,error:{message:knowledgeWorkError(error).code}};}}
    if(fnName==='knowledge-work'){try{return {data:await knowledgeWorkMock(db,currentSession?.user.id,body),error:null};}
      catch(error){return {data:{error:knowledgeWorkError(error).code},error:null};}}
    if(fnName==='task-work-command') {try{return {data:taskWorkMockCommand(db,currentSession?.user.id,body),error:null as null};}
      catch(error){return {data:{error:taskWorkError(error).code},error:null as null};}}
    if (fnName === 'approval-command') {
      try { return {data:mockApprovalCommand(db,currentSession?.user.id,body,uuid),error:null}; }
      catch (error) { return {data:{error:error instanceof Error ? error.message : 'approval_invalid_input'},error:null}; }
    }

    if (fnName === 'manage-member') {
      return this.manageMember(body as unknown as ManageMemberBody);
    }

    return { data: null, error: { message: `Unknown function: ${fnName}` } };
  }

  private async manageMember(body: ManageMemberBody) {
    const members = tbl('members');

    if (body.action === 'create') {
      // Check duplicate email
      if (members.find(m => (m as DbRow).email === body.email)) {
        return { data: { error: '此 Email 已存在' }, error: null };
      }
      const newMember: DbRow = {
        id: `u-${uuid().slice(0, 8)}`,
        name: body.name,
        avatar: body.avatar || (body.name || '').slice(0, 1).toUpperCase(),
        role: body.role || 'member',
        job_title: body.jobTitle || '',
        color: body.color || '#6B778C',
        email: body.email,
        is_active: true,
        sort_order: members.length,
        auth_id: null,
      };
      members.push(newMember);
      return { data: { member: newMember }, error: null };
    }

    if (body.action === 'toggle_active') {
      const member = members.find(m => m.id === body.memberId);
      if (!member) return { data: { error: '找不到成員' }, error: null };
      member.is_active = body.isActive;
      return { data: { success: true }, error: null };
    }

    if (body.action === 'delete') {
      const idx = members.findIndex(m => m.id === body.memberId);
      if (idx < 0) return { data: { error: '找不到成員' }, error: null };
      // Same as the servers: a member with tasks, comments or records can only be deactivated.
      const id = body.memberId;
      const hasHistory = tbl('tasks').some(t => t.creator_id === id || t.assignee_id === id || t.reviewer_id === id)
        || tbl('comments').some(c => c.user_id === id) || tbl('status_logs').some(l => l.changed_by === id)
        || tbl('notifications').some(n => n.recipient_id === id || n.sender_id === id);
      if (hasHistory) return { data: { error: 'member_has_history' }, error: null };
      members.splice(idx, 1);
      return { data: { success: true }, error: null };
    }

    return { data: { error: 'Unknown action' }, error: null };
  }
}

// ─── Storage ─────────────────────────────────────────────────────────────

const mockFiles = new Map<string, { file: Blob; url: string }>();
class MockBucket {
  private name: string;
  constructor(name: string) { this.name = name; }
  async upload(path: string, file: Blob | File) {
    const key = `${this.name}/${path}`;
    const old = mockFiles.get(key);
    if (old) URL.revokeObjectURL(old.url);
    mockFiles.set(key, { file, url: URL.createObjectURL(file) });
    return { data: { path }, error: null };
  }
  async download(path: string) { return { data: mockFiles.get(`${this.name}/${path}`)?.file || new Blob(), error: null }; }
  getPublicUrl(path: string) { return { data: { publicUrl: mockFiles.get(`${this.name}/${path}`)?.url || '' } }; }
  async remove(paths: string[]) {
    for (const path of paths) {
      const key = `${this.name}/${path}`;
      const entry = mockFiles.get(key);
      if (entry) URL.revokeObjectURL(entry.url);
      mockFiles.delete(key);
    }
    return { data: paths, error: null };
  }
  async list(_path?: string): Promise<{data:DbRow[];error:null}> { return { data: [] as DbRow[], error: null }; }
}

class MockStorage {
  from(bucket: string) { return new MockBucket(bucket); }
}

// ─── Realtime Channel (with Presence support) ────────────────────────────

class MockChannel {
  private _presenceState: Record<string, DbRow[]> = {};
  private _subscribeCb: ((status: string) => void) | null = null;

  on(_ev: string, _cfg: Record<string, unknown>, _cb?: (...args: unknown[]) => void) { return this; }

  subscribe(cb?: (status: string) => void) {
    this._subscribeCb = cb || null;
    // Call callback async with 'SUBSCRIBED' to match Supabase behavior
    if (cb) setTimeout(() => cb('SUBSCRIBED'), 0);
    return this;
  }

  unsubscribe() { this._presenceState = {}; }

  // Presence API
  presenceState() { return this._presenceState; }

  async track(payload: DbRow) {
    // Store in local presence state under a key
    this._presenceState['_self'] = [payload];
  }

  async untrack() {
    delete this._presenceState['_self'];
  }
}

// ─── Main Client ─────────────────────────────────────────────────────────

export class MockSupabaseClient {
  auth = new MockAuth();
  storage = new MockStorage();
  functions = new MockFunctions();
  private channels = new Map<string, MockChannel>();

  from(tableName: string): TableRef { return new TableRef(tableName); }

  // Minimal RPC surface so demo / offline mode never throws.
  // License RPCs return "no license" — the demo professional tier is
  // granted by LicenseContext's demo path, NOT by faking activation,
  // so the real HMAC path stays completely untouched.
  async rpc(fnName: string, _params?: Record<string, unknown>): Promise<ThenableResult> {
    if (['livo_set_task_reminder','livo_set_task_deadline'].includes(fnName)) {
      try { return {data:planningMockRpc(db,currentSession?.user.id,fnName,_params||{}),error:null}; }
      catch(e) { return {data:null,error:{message:e instanceof TaskPlanningError?e.code:'planning_failed'}}; }
    }
    switch (fnName) {
      case 'check_license':
        return {
          data: {
            valid: false, tier: 'none', email: null, expires_at: null,
            is_expired: false, installation_id: null, installation_bound: false,
          },
          error: null,
        };
      case 'activate_license':
        return {
          data: { valid: false, error: 'invalid_signature', message: '展示模式無法啟用授權' },
          error: null,
        };
      case 'reset_license':
        return { data: { success: false, message: '展示模式' }, error: null };
      // Demo: the Slack link setting lives for this tab only, like every other demo change.
      case 'livo_slack_link_status':
        return { data: { ...demoSlackLink }, error: null };
      case 'livo_slack_link_set':
        demoSlackLink.disabled = _params?.p_enabled === false;
        return { data: { ...demoSlackLink }, error: null };
      case 'acquire_field_lock':
        return { data: { acquired: true } as unknown, error: null };
      case 'release_field_lock':
        return { data: true, error: null };
      default:
        return { data: null, error: null };
    }
  }

  channel(name: string, _opts?: Record<string, unknown>): MockChannel {
    if (!this.channels.has(name)) this.channels.set(name, new MockChannel());
    return this.channels.get(name)!;
  }

  removeChannel(ch: MockChannel) {
    for (const [k, v] of this.channels) {
      if (v === ch) { this.channels.delete(k); break; }
    }
  }

  static resetMockData() {
    Object.keys(db).forEach(k => db[k] = []);
    currentSession = null;
    authListeners.length = 0;
    localStorage.removeItem('mock-auth-session');
    initializeData();
  }
}

export function createMockClient(): MockSupabaseClient {
  return new MockSupabaseClient();
}
