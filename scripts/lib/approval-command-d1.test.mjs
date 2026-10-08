// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeApprovalCommand, handleApprovalCommand } from '../../worker/src/approval';
import { runQuery } from '../../worker/src/db';
import { handleSlackNotify } from '../../worker/src/functions/slack';
import { approvalDeliveryMessage, approvalThread, approvalTaskUrl, deliverApprovalJob, runApprovalDeliveries } from '../../worker/src/approvalDelivery';
import { applyPostTenantSchemaUpgrades } from '../../worker/migrate/schema-upgrades.mjs';
vi.mock('../../worker/src/license', () => ({ checkProfessional: async () => true }));
const schema = readFileSync(new URL('../../worker/schema.sql', import.meta.url), 'utf8');
let db, env, seq;
class Statement {
    sql;
    args = [];
    constructor(sql) {
        this.sql = sql;
    }
    bind(...args) { this.args = args; return this; }
    async first() { return db.prepare(this.sql).get(...this.args) ?? null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args), success: true }; }
    async run() { return { meta: db.prepare(this.sql).run(...this.args), success: true }; }
}
const actor = (id = 'requester') => ({ userId: id, email: id + '@example.test', member: { id, role: id === 'super' ? 'super_admin' : id === 'approver' ? 'admin' : 'member', email: id + '@example.test', name: id, workspaceId: 'a' } });
const row = (table, id) => db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
const count = (table) => Number(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);
const commandId = () => `command-${++seq}`;
const submit = (taskId = 'task', ruleId = 'rule') => ({ commandId: commandId(), operation: 'submit', taskId, expected: { statusId: 'todo', requiresApproval: false, currentApprovalId: null, approvalStatus: null }, toStatusId: 'done', expectedRuleId: ruleId, enableRequirement: false });
async function action(request, operation = 'approve', who = 'approver') {
    return executeApprovalCommand(env, actor(who), { commandId: commandId(), operation, requestId: request.id, expectedVersion: request.version, expectedStep: request.current_step, comment: ' reviewed ' });
}
beforeEach(() => {
    seq = 0;
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON');
    db.exec(schema);
    env = { DB: { prepare: (sql) => new Statement(sql), batch: async (statements) => {
                db.exec('BEGIN');
                try {
                    const values = [];
                    for (const s of statements)
                        values.push(await s.run());
                    db.exec('COMMIT');
                    return values;
                }
                catch (e) {
                    db.exec('ROLLBACK');
                    throw e;
                }
            } }, APP_BASE_URL: 'http://localhost:8080/app', SLACK_BOT_TOKEN: 'unit-test-token' };
    for (const [id, role, ws] of [['requester', 'member', 'a'], ['approver', 'admin', 'a'], ['super', 'super_admin', 'a'], ['other', 'member', 'a'], ['foreign', 'admin', 'b']]) {
        // Real legacy members have a live login; email trust uses schema DEFAULT1.
        db.prepare("INSERT INTO members(workspace_id,id,name,avatar,role,email,auth_id) VALUES(?,?,?,'',?,?,?)").run(ws, id, id, role, id + '@example.test', id);
        db.prepare("INSERT INTO auth_users(id,email,banned) SELECT id,email,0 FROM members WHERE id=?").run(id);
    }
    db.exec(`INSERT INTO product_lines(workspace_id,id,name) VALUES('a','line','Line'),('b','foreign-line','Other');
    INSERT INTO projects(workspace_id,id,line_id,name,key) VALUES('a','project','line','Project','P'),('b','foreign-project','foreign-line','Other','O');
    INSERT INTO statuses(workspace_id,id,name,is_done,auto_start) VALUES('a','todo','Todo',0,0),('a','done','Done',1,1),('b','foreign-status','Other',0,0);
    INSERT INTO tasks(workspace_id,id,task_key,project_id,title,status_id,creator_id) VALUES('a','task','P-1','project','Task','todo','requester'),('a','second','P-2','project','Second','todo','requester');
    INSERT INTO system_settings(workspace_id,key,value) VALUES('a','feature_toggles','{"approvals":true}');
    INSERT INTO approval_rules(workspace_id,id,project_id,from_status,to_status,created_by) VALUES('a','rule','project','todo','done','approver');
    INSERT INTO approval_rule_steps(workspace_id,id,rule_id,step_order,approver_type,approver_role) VALUES('a','step1','rule',1,'role','admin');`);
});
afterEach(() => { db.close(); vi.restoreAllMocks(); });
describe('native SQLite atomic approval commands', () => {
    it('commits request, immutable snapshot, task, in-app notification, audit and receipt in one statement', async () => {
        const result = await executeApprovalCommand(env, actor(), submit());
        expect(result.task.current_approval_id).toBe(result.request.id);
        expect(result.request.version).toBe(1);
        expect(result.request.steps_snapshot).toEqual([{ step_order: 1, approver_type: 'role', approver_role: 'admin', approver_user_id: null }]);
        expect(count('notifications')).toBe(1);
        expect(count('approval_events')).toBe(1);
        expect(count('approval_command_receipts')).toBe(1);
        expect(count('approval_command_contexts')).toBe(0);
    });
    it('replays a completed intent exactly once; changed payload or actor cannot reuse its id', async () => {
        const intent = submit(), one = await executeApprovalCommand(env, actor(), intent), two = await executeApprovalCommand(env, actor(), intent);
        expect(two).toEqual({ ...one, replayed: true });
        expect(count('approval_requests')).toBe(1);
        expect(count('notifications')).toBe(1);
        await expect(executeApprovalCommand(env, actor(), { ...intent, enableRequirement: true })).rejects.toMatchObject({ code: 'approval_idempotency_conflict' });
        await expect(executeApprovalCommand(env, actor('other'), intent)).rejects.toMatchObject({ code: 'approval_idempotency_conflict' });
    });
    it('rolls everything back when the final receipt insertion fails', async () => {
        db.exec("CREATE TRIGGER injected_final_failure BEFORE INSERT ON approval_command_receipts BEGIN SELECT RAISE(ABORT,'approval_injected_failure'); END;");
        await expect(executeApprovalCommand(env, actor(), submit())).rejects.toMatchObject({ code: 'approval_unavailable', status:503 });
        for (const table of ['approval_requests', 'approval_actions', 'approval_events', 'notifications', 'activity_logs', 'approval_command_contexts'])
            expect(count(table)).toBe(0);
        expect(row('tasks', 'task').current_approval_id).toBeNull();
    });
    it('enforces exact role and current active membership even if auth role is stale', async () => {
        const one = await executeApprovalCommand(env, actor(), submit());
        await expect(action(one.request, 'approve', 'super')).rejects.toMatchObject({ code: 'approval_forbidden' });
        db.exec("UPDATE members SET role='member' WHERE id='approver'");
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_forbidden' });
        db.exec("UPDATE members SET role='admin',is_active=0 WHERE id='approver'");
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_unavailable' });
        expect(count('approval_actions')).toBe(0);
    });
    it('allows only the named user at a configured user step, without administrator override', async () => {
        db.exec("UPDATE approval_rule_steps SET approver_type='user',approver_role=NULL,approver_user_id='other' WHERE id='step1'");
        const one = await executeApprovalCommand(env, actor(), submit());
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_forbidden' });
        expect((await action(one.request, 'approve', 'other')).request.status).toBe('approved');
    });
    it('rejects cross-workspace actors, target statuses and rule steps', async () => {
        await expect(executeApprovalCommand(env, { ...actor('foreign'), member: { ...actor('foreign').member, workspaceId: 'b' } }, submit())).rejects.toMatchObject({ code: 'approval_unavailable' });
        await expect(executeApprovalCommand(env, actor(), { ...submit(), toStatusId: 'foreign-status' })).rejects.toMatchObject({ code: 'approval_rule_invalid' });
        expect(() => db.exec("UPDATE approval_rule_steps SET approver_type='user',approver_role=NULL,approver_user_id='foreign' WHERE id='step1'")).toThrow('approval_rule_invalid');
    });
    it('rejects discontinuous or empty rule steps', async () => {
        db.exec("UPDATE approval_rule_steps SET step_order=2 WHERE id='step1'");
        await expect(executeApprovalCommand(env, actor(), submit())).rejects.toMatchObject({ code: 'approval_rule_invalid' });
        db.exec('DELETE FROM approval_rule_steps');
        await expect(executeApprovalCommand(env, actor(), submit())).rejects.toMatchObject({ code: 'approval_rule_invalid' });
    });
    it('requires the rule expected by the caller and prevents concurrent duplicate requests', async () => {
        await expect(executeApprovalCommand(env, actor(), submit('task', null))).rejects.toMatchObject({ code: 'approval_rule_invalid' });
        await executeApprovalCommand(env, actor(), submit());
        await expect(executeApprovalCommand(env, actor(), submit())).rejects.toMatchObject({ code: 'approval_conflict' });
    });
    it('supports default administrator approval only when there is no matching rule', async () => {
        db.exec('DELETE FROM approval_rule_steps;DELETE FROM approval_rules');
        await expect(executeApprovalCommand(env, actor(), submit('task', null))).rejects.toMatchObject({code:'approval_not_required'});
        expect(count('approval_requests')).toBe(0);
        const one = await executeApprovalCommand(env, actor(), {...submit('task', null),enableRequirement:true});
        expect(one.task.requires_approval).toBe(true);
        expect(one.request.steps_snapshot).toHaveLength(1);
        expect((await action(one.request, 'approve', 'super')).request.status).toBe('approved');
    });
    it('final approval changes status, dates and history atomically, and rejects stale actions', async () => {
        const one = await executeApprovalCommand(env, actor(), submit()), done = await action(one.request);
        expect(done.request.status).toBe('approved');
        expect(done.request.version).toBe(2);
        expect(done.task.status_id).toBe('done');
        expect(done.task.current_approval_id).toBeNull();
        expect(done.task.started_at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(done.task.completed_at).toBeTruthy();
        expect(count('status_logs')).toBe(1);
        expect(count('approval_actions')).toBe(1);
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_conflict' });
        expect(count('status_logs')).toBe(1);
    });
    it('advances exactly one step and rejects a previous step intent before final approval', async () => {
        db.exec("INSERT INTO approval_rule_steps(workspace_id,id,rule_id,step_order,approver_type,approver_user_id) VALUES('a','step2','rule',2,'user','other')");
        const one = await executeApprovalCommand(env, actor(), submit()), next = await action(one.request);
        expect(next.request.current_step).toBe(2);
        expect(next.request.version).toBe(2);
        expect(next.task.status_id).toBe('todo');
        expect(count('status_logs')).toBe(0);
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_conflict' });
        expect((await action(next.request, 'approve', 'other')).request.status).toBe('approved');
    });
    it.each(['reject', 'return'])('%s clears pending pointers and preserves task status', async (operation) => {
        const one = await executeApprovalCommand(env, actor(), submit()), result = await action(one.request, operation);
        expect(result.request.status).toBe(operation === 'return' ? 'returned' : 'rejected');
        expect(result.task.status_id).toBe('todo');
        expect(result.task.current_approval_id).toBeNull();
        expect(count('status_logs')).toBe(0);
    });
    it('withdraws only as requester/admin, including after feature disabled in legacy state', async () => {
        const one = await executeApprovalCommand(env, actor(), submit()), intent = { commandId: commandId(), operation: 'withdraw', requestId: one.request.id, expectedVersion: 1 };
        await expect(executeApprovalCommand(env, actor('other'), intent)).rejects.toMatchObject({ code: 'approval_forbidden' });
        const result = await executeApprovalCommand(env, actor(), intent);
        expect(result.request.status).toBe('cancelled');
        expect(result.task.current_approval_id).toBeNull();
        db.exec("UPDATE system_settings SET value='{\"approvals\":false}' WHERE key='feature_toggles'");
        await expect(executeApprovalCommand(env, actor(), submit())).rejects.toMatchObject({ code: 'approval_disabled' });
    });
    it('blocks old generic approval writes and a combined clear-flag/status bypass', async () => {
        expect(() => db.exec("INSERT INTO approval_requests(id,task_id,requested_by,from_status,to_status) VALUES('forged','task','requester','todo','done')")).toThrow('approval_forbidden');
        const one = await executeApprovalCommand(env, actor(), submit());
        expect(() => db.exec("UPDATE tasks SET requires_approval=0,current_approval_id=NULL,approval_status=NULL,status_id='done' WHERE id='task'")).toThrow('approval_forbidden');
        expect(() => db.exec(`UPDATE approval_requests SET status='approved' WHERE id='${one.request.id}'`)).toThrow('approval_forbidden');
        expect(() => db.exec("DELETE FROM tasks WHERE id='task'")).toThrow('approval_conflict');
        expect(count('approval_actions')).toBe(0);
    });
    it('prevents pending rule, steps, project archival, target deletion and destructive history cascades', async () => {
        await executeApprovalCommand(env, actor(), submit());
        for (const sql of ["UPDATE approval_rules SET is_active=0 WHERE id='rule'", "DELETE FROM approval_rules WHERE id='rule'", "DELETE FROM approval_rule_steps WHERE id='step1'", "UPDATE approval_rule_steps SET approver_role='member' WHERE id='step1'", "UPDATE projects SET is_archived=1 WHERE id='project'", "DELETE FROM statuses WHERE id='done'"])
            expect(() => db.exec(sql)).toThrow('approval_rule_in_use');
    });
    it('requires a command for nonpending requirement changes and blocks pending changes', async () => {
        expect(() => db.exec("UPDATE tasks SET requires_approval=1 WHERE id='task'")).toThrow('approval_forbidden');
        const intent = { commandId: commandId(), operation: 'set_requirement', taskId: 'task', expectedRequiresApproval: false, enabled: true };
        const result = await executeApprovalCommand(env, actor(), intent);
        expect(result.task.requires_approval).toBe(true);
        expect(() => db.exec("UPDATE tasks SET status_id='done' WHERE id='task'")).toThrow('approval_forbidden');
        const one = await executeApprovalCommand(env, actor(), { ...submit(), expected: { statusId: 'todo', requiresApproval: true, currentApprovalId: null, approvalStatus: null } });
        // An administrator may remove the requirement, but not while a request is pending.
        await expect(executeApprovalCommand(env, actor('approver'), { ...intent, commandId: commandId(), expectedRequiresApproval: true, enabled: false })).rejects.toMatchObject({ code: 'approval_conflict' });
        expect(one.request.status).toBe('pending');
    });
    it('lets any member require approval but only live administrators remove the requirement', async () => {
        const on = () => ({ commandId: commandId(), operation: 'set_requirement', taskId: 'task', expectedRequiresApproval: false, enabled: true });
        const off = (who) => executeApprovalCommand(env, actor(who), { commandId: commandId(), operation: 'set_requirement', taskId: 'task', expectedRequiresApproval: true, enabled: false });
        expect((await executeApprovalCommand(env, actor(), on())).task.requires_approval).toBe(true);
        for (const who of ['requester', 'other'])
            await expect(off(who)).rejects.toMatchObject({ code: 'approval_requirement_admin_only', status: 403 });
        expect(row('tasks', 'task').requires_approval).toBe(1);
        expect(count('approval_command_receipts')).toBe(1);
        expect((await off('approver')).task.requires_approval).toBe(false);
        await executeApprovalCommand(env, actor(), on());
        expect((await off('super')).task.requires_approval).toBe(false);
        // The database checks the live role, not the adapter's possibly stale session role.
        await executeApprovalCommand(env, actor(), on());
        db.exec("UPDATE members SET role='member' WHERE id='approver'");
        await expect(off('approver')).rejects.toMatchObject({ code: 'approval_requirement_admin_only' });
        db.exec("UPDATE system_settings SET value='{\"approvals\":false}' WHERE key='feature_toggles'");
        await expect(off('requester')).rejects.toMatchObject({ code: 'approval_requirement_admin_only' });
        expect((await off('super')).task.requires_approval).toBe(false);
    });
    it('never lets a requester decide their own request, even as administrator or owner', async () => {
        const own = await executeApprovalCommand(env, actor('approver'), submit());
        for (const operation of ['approve', 'reject', 'return'])
            await expect(action(own.request, operation, 'approver')).rejects.toMatchObject({ code: 'approval_self_decision_forbidden', status: 403 });
        expect(count('approval_actions')).toBe(0);
        expect(row('approval_requests', own.request.id).status).toBe('pending');
        // No one else holds the exact admin role, so the request waits; its requester may withdraw it.
        await expect(action(own.request, 'approve', 'super')).rejects.toMatchObject({ code: 'approval_forbidden' });
        const withdrawn = await executeApprovalCommand(env, actor('approver'), { commandId: commandId(), operation: 'withdraw', requestId: own.request.id, expectedVersion: 1 });
        expect(withdrawn.request.status).toBe('cancelled');
        // Default administrator fallback (no rule): the owner cannot approve their own request either.
        db.exec("INSERT INTO statuses(workspace_id,id,name,is_done,auto_start) VALUES('a','review','Review',0,0)");
        const fallback = await executeApprovalCommand(env, actor('super'), { ...submit('second', null), toStatusId: 'review', enableRequirement: true });
        await expect(action(fallback.request, 'approve', 'super')).rejects.toMatchObject({ code: 'approval_self_decision_forbidden' });
        expect((await action(fallback.request, 'approve', 'approver')).request.status).toBe('approved');
    });
    it('blocks a named user step when that user is the requester', async () => {
        db.exec("UPDATE approval_rule_steps SET approver_type='user',approver_role=NULL,approver_user_id='requester' WHERE id='step1'");
        const one = await executeApprovalCommand(env, actor(), submit());
        await expect(action(one.request, 'approve', 'requester')).rejects.toMatchObject({ code: 'approval_self_decision_forbidden' });
        expect(count('approval_actions')).toBe(0);
        expect(count('approval_command_receipts')).toBe(1);
    });
    it('does not ask a requester to approve their own request at a later step', async () => {
        db.exec("INSERT INTO approval_rule_steps(workspace_id,id,rule_id,step_order,approver_type,approver_role) VALUES('a','step2','rule',2,'role','member')");
        const one = await executeApprovalCommand(env, actor(), submit()), next = await action(one.request);
        expect(next.request.current_step).toBe(2);
        const asked = db.prepare("SELECT recipient_id FROM notifications WHERE type='approval_requested' AND id LIKE ? ORDER BY recipient_id").all(next.eventId + ':%');
        expect(asked.map(r => r.recipient_id)).toEqual(['other']);
        await expect(action(next.request, 'approve', 'requester')).rejects.toMatchObject({ code: 'approval_self_decision_forbidden' });
        expect((await action(next.request, 'approve', 'other')).request.status).toBe('approved');
    });
    it('checks prerequisites both on submit and again before final approval', async () => {
        const one = await executeApprovalCommand(env, actor(), submit());
        db.exec("INSERT INTO status_transition_rules(workspace_id,id,target_status_id,required_status_id) VALUES('a','prereq','done','todo')");
        await expect(action(one.request)).rejects.toMatchObject({ code: 'approval_transition_prerequisite' });
        expect(count('approval_actions')).toBe(0);
        await expect(executeApprovalCommand(env, actor(), submit('second'))).rejects.toMatchObject({ code: 'approval_transition_prerequisite' });
        db.exec("INSERT INTO status_logs(workspace_id,id,task_id,to_status_id,changed_by) VALUES('a','visited','task','todo','requester')");
        expect((await action(one.request)).request.status).toBe('approved');
    });
    it('rechecks task visibility on an idempotent readback', async () => {
        const intent = submit();
        await executeApprovalCommand(env, actor(), intent);
        db.exec("UPDATE members SET is_active=0 WHERE id='requester'");
        await expect(executeApprovalCommand(env, actor(), intent)).rejects.toMatchObject({ code: 'approval_unavailable' });
    });
    it('only one concurrent decision can consume an expected request version', async () => {
        const one = await executeApprovalCommand(env, actor(), submit());
        const both = await Promise.allSettled([action(one.request), action(one.request, 'reject')]);
        expect(both.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(both.filter(r => r.status === 'rejected')).toHaveLength(1);
        expect(count('approval_actions')).toBe(1);
        expect(row('approval_requests', one.request.id).version).toBe(2);
    });
    it('two retries of one concurrent command return one durable outcome', async () => {
        const intent = submit(), both = await Promise.all([executeApprovalCommand(env, actor(), intent), executeApprovalCommand(env, actor(), intent)]);
        expect(both[0].request.id).toBe(both[1].request.id);
        expect(both.map(r => r.replayed).sort()).toEqual([false, true]);
        expect(count('approval_events')).toBe(1);
    });
    it('does not allow a durable receipt to authorize a later generic mutation', async () => {
        const one = await executeApprovalCommand(env, actor(), submit());
        await action(one.request);
        expect(count('approval_command_contexts')).toBe(0);
        expect(() => db.exec("UPDATE tasks SET requires_approval=1 WHERE id='task'")).toThrow('approval_forbidden');
    });
    it('records only scoped channel and opted-in DM jobs in the domain transaction', async () => {
        db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','slack_delivery',?)").run(JSON.stringify({ enabled: true, teamId: 'TUNIT', dmEnabled: true, dmMemberIds: ['approver'], routes: [{ projectId: 'project', channelId: 'CUNIT' }, { projectId: 'elsewhere', channelId: 'COTHER' }] }));
        await executeApprovalCommand(env, actor(), submit());
        const jobs = db.prepare('SELECT target_id,delivery_type FROM approval_delivery_outbox ORDER BY delivery_type').all();
        expect(jobs).toEqual([{ target_id: 'CUNIT', delivery_type: 'channel' }, { target_id: 'approver', delivery_type: 'dm' }]);
    });
    it('applies schema upgrade guards twice without modifying historical records', async () => {
        const first = await executeApprovalCommand(env, actor(), submit());
        await action(first.request);
        const history = JSON.stringify(db.prepare('SELECT * FROM approval_requests').all());
        const adapter = { queryRows: (sql) => db.prepare(sql).all(), applyFile: (name) => db.exec(readFileSync(new URL('../../worker/migrate/' + name, import.meta.url), 'utf8')) };
        await applyPostTenantSchemaUpgrades(adapter);
        await applyPostTenantSchemaUpgrades(adapter);
        expect(JSON.stringify(db.prepare('SELECT * FROM approval_requests').all())).toBe(history);
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    });
});
describe('approval migration preserves legacy evidence',()=>{
    it('blocks client-created Slack verification and changes to existing Slack identity rows',async()=>{
        const ctx={waitUntil:()=>{}};
        for(const op of ['insert','upsert']){
          const result=await runQuery(env,ctx,actor(),{table:'external_account_bindings',op,values:{member_id:'requester',platform:'slack',platform_user_id:'UFORGED',platform_team_id:'TUNIT',is_verified:true}});
          expect(result.error).toBeTruthy();expect(count('external_account_bindings')).toBe(0);
        }
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by) VALUES('a','trusted-binding','requester','slack','UUNIT','TUNIT',1,'admin')");
        const filters=[{col:'id',op:'eq',val:'trusted-binding'}];
        await runQuery(env,ctx,actor(),{table:'external_account_bindings',op:'update',filters,values:{platform_user_id:'UFORGED'}});
        await runQuery(env,ctx,actor(),{table:'external_account_bindings',op:'delete',filters});
        expect(row('external_account_bindings','trusted-binding').platform_user_id).toBe('UUNIT');
    });
    function legacyDatabase(){
        const tables=['members','product_lines','projects','statuses','tasks','system_settings','approval_rules','approval_rule_steps'];
        const source=Object.fromEntries(tables.map(t=>[t,db.prepare(`SELECT * FROM ${t}`).all()]));
        db.close();db=new DatabaseSync(':memory:');db.exec('PRAGMA foreign_keys=ON');
        const old=schema.slice(0,schema.indexOf('-- Atomic approval commands.'))
          .replace(/  completed_at TEXT,\r?\n  version INTEGER NOT NULL DEFAULT 1 CHECK\(version > 0\),\r?\n  steps_snapshot TEXT,\r?\n  rule_snapshot TEXT/,'  completed_at TEXT')
          .replace(/  acted_at   TEXT NOT NULL DEFAULT \(strftime\('%Y-%m-%dT%H:%M:%fZ','now'\)\),\r?\n  command_id TEXT,\r?\n  request_version INTEGER/,"  acted_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
          .replace(/  verified_by[^\r\n]*\r?\n/,'');
        db.exec(old);expect(db.prepare('PRAGMA table_info(approval_requests)').all().some(c=>c.name==='version')).toBe(false);
        for(const table of tables)for(const r of source[table]){const cols=Object.keys(r);db.prepare(`INSERT ${table==='system_settings'?'OR REPLACE ':''}INTO ${table}(${cols.join(',')}) VALUES(${cols.map(()=>'?').join(',')})`).run(...Object.values(r));}
    }
    const upgrade=()=>applyPostTenantSchemaUpgrades({queryRows:sql=>db.prepare(sql).all(),applyFile:name=>db.exec(readFileSync(new URL('../../worker/migrate/'+name,import.meta.url),'utf8'))});
    it('adds binding verifier once and never certifies legacy self-verification',async()=>{
        legacyDatabase();
        expect(db.prepare('PRAGMA table_info(external_account_bindings)').all().some(c=>c.name==='verified_by')).toBe(false);
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified) VALUES('a','old-binding','approver','slack','UUNIT','TUNIT',1)");
        await upgrade();await upgrade();
        expect(row('external_account_bindings','old-binding').is_verified).toBe(1);
        expect(row('external_account_bindings','old-binding').verified_by).toBeNull();
    });
    it('upgrades an old pending request twice, refuses fabricated approval and permits withdrawal',async()=>{
        legacyDatabase();db.exec("INSERT INTO approval_requests(workspace_id,id,task_id,rule_id,requested_by,from_status,to_status) VALUES('a','legacy','task','rule','requester','todo','done');UPDATE tasks SET current_approval_id='legacy',approval_status='pending_approval' WHERE id='task'");
        await upgrade();await upgrade();expect(row('approval_requests','legacy').steps_snapshot).toBeNull();
        await expect(executeApprovalCommand(env,actor('approver'),{commandId:commandId(),operation:'approve',requestId:'legacy',expectedVersion:1,expectedStep:1})).rejects.toMatchObject({code:'approval_rule_invalid'});
        const withdrawn=await executeApprovalCommand(env,actor(),{commandId:commandId(),operation:'withdraw',requestId:'legacy',expectedVersion:1});
        expect(withdrawn.request.status).toBe('cancelled');expect(count('approval_actions')).toBe(0);expect(withdrawn.task.current_approval_id).toBeNull();
    });
    it('refuses inconsistent old requests without deleting or upgrading rows',async()=>{
        legacyDatabase();db.exec("INSERT INTO approval_requests(workspace_id,id,task_id,requested_by,from_status,to_status) VALUES('a','orphan','task','requester','todo','done')");
        await expect(upgrade()).rejects.toThrow('Inconsistent pending approvals');expect(count('approval_requests')).toBe(1);
        expect(db.prepare('PRAGMA table_info(approval_requests)').all().some(c=>c.name==='version')).toBe(false);
    });
    it('rolls back a destructive child-first batch when a task has a pending approval',async()=>{
        await executeApprovalCommand(env,actor(),submit());db.exec("INSERT INTO comments(workspace_id,id,task_id,user_id,content) VALUES('a','comment','task','requester','retain evidence')");
        await expect(env.DB.batch([env.DB.prepare("DELETE FROM comments WHERE workspace_id='a'"),env.DB.prepare("DELETE FROM tasks WHERE workspace_id='a'")])).rejects.toThrow('approval_conflict');
        expect(count('comments')).toBe(1);expect(count('tasks')).toBe(2);
    });
});
describe('approval delivery presentation and retry safety', () => {
    it('rejects oversized command input with a safe 413 before any writes',async()=>{
        const request=new Request('https://example.test/approval-command',{method:'POST',body:' '.repeat(32769)});
        const context={env,get:()=>actor(),req:{raw:request},json:(body,status=200)=>new Response(JSON.stringify(body),{status})};
        const result=await handleApprovalCommand(context);
        expect(result.status).toBe(413);
        expect(await result.json()).toEqual({error:'approval_request_too_large'});
        expect(count('approval_command_receipts')).toBe(0);
    });
    it.each([
        {type:'approval_request',blocks:[{type:'section',text:{type:'mrkdwn',text:'fabricated'}}]},
        {type:'approval_completed'},
        {type:'task_updated',eventType:'approval_completed'},
    ])('rejects client-supplied approval notices before any token lookup',async(payload)=>{
        const prepare=vi.fn(()=>{throw new Error('must not resolve a token or send');});
        const context={env:{DB:{prepare}},get:()=>actor(),req:{json:async()=>payload},json:(body,status=200)=>new Response(JSON.stringify(body),{status})};
        const result=await handleSlackNotify(context);
        expect(result.status).toBe(409);
        expect(await result.json()).toEqual({error:'approval_command_required'});
        expect(prepare).not.toHaveBeenCalled();
    });
    async function queued(type = 'channel') {
        db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','slack_delivery',?)").run(JSON.stringify({ enabled: true, teamId: 'TUNIT', dmEnabled: true, routes: [{ projectId: 'project', channelId: 'CUNIT' }] }));
        db.exec("INSERT INTO slack_config(id,bot_token) VALUES('a','unit-test-token')");
        const result = await executeApprovalCommand(env, actor(), submit());
        db.exec("UPDATE approval_delivery_outbox SET state='sending',attempts=1,lease_token='unit-lease',lease_expires_at='2999-01-01T00:00:00.000Z'");
        const job = db.prepare('SELECT * FROM approval_delivery_outbox WHERE delivery_type=?').get(type);
        return { result, job };
    }
    const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    it('sends a titled channel card, saves its root and marks a claimed job sent', async () => {
        const { job } = await queued();
        const calls = [];
        const network = vi.fn(async (url, options) => {
            const method = String(url).split('/').pop();
            calls.push(method);
            if (method === 'auth.test')
                return response({ ok: true, team_id: 'TUNIT' });
            const body = JSON.parse(options.body);
            expect(body.channel).toBe('CUNIT');
            expect(body.text).toContain('P-1 Task');
            expect(body.thread_ts).toBeUndefined();
            return response({ ok: true, ts: '1000.1' });
        });
        expect(await deliverApprovalJob(env, job, network)).toBe('sent');
        expect(calls).toEqual(['auth.test', 'chat.postMessage']);
        expect(row('approval_delivery_outbox', job.id).state).toBe('sent');
        expect(count('approval_delivery_threads')).toBe(1);
    });
    it('does not retry an ambiguous post or an expired send lease', async () => {
        const { job } = await queued();
        const network = vi.fn(async (url) => { if (String(url).endsWith('auth.test'))
            return response({ ok: true, team_id: 'TUNIT' }); throw new Error('response lost after post'); });
        expect(await deliverApprovalJob(env, job, network)).toBe('review');
        expect(row('approval_delivery_outbox', job.id).last_error).toBe('transport_unavailable');
        db.exec("UPDATE approval_delivery_outbox SET state='sending',lease_expires_at='2000-01-01',lease_token='expired' WHERE delivery_type='dm'");
        await runApprovalDeliveries(env, 'a', network);
        expect(network).toHaveBeenCalledTimes(2);
        expect(db.prepare("SELECT count(*) AS n FROM approval_delivery_outbox WHERE state='review'").get()).toMatchObject({ n: 2 });
    });
    it('persists rate-limit delay for a safe retry', async () => {
        const { job } = await queued();
        const network = vi.fn(async (url) => String(url).endsWith('auth.test') ? response({ ok: true, team_id: 'TUNIT' }) : new Response('', { status: 429, headers: { 'retry-after': '120' } }));
        expect(await deliverApprovalJob(env, job, network)).toBe('pending');
        const saved = row('approval_delivery_outbox', job.id);
        expect(saved.last_error).toBe('rate_limited');
        expect(Date.parse(saved.next_attempt_at) - Date.now()).toBeGreaterThan(118000);
    });
    it('skips a superseded step before contacting Slack', async () => {
        const { job, result } = await queued();
        await action(result.request);
        const network = vi.fn();
        expect(await deliverApprovalJob(env, job, network)).toBe('skipped');
        expect(network).not.toHaveBeenCalled();
    });
    it('skips disabled delivery and changed project routes without posting', async () => {
        const { job } = await queued();
        db.exec("UPDATE system_settings SET value='{\"enabled\":true,\"teamId\":\"TUNIT\",\"routes\":[]}' WHERE key='slack_delivery'");
        const network = vi.fn(async () => response({ ok: true, team_id: 'TUNIT' }));
        expect(await deliverApprovalJob(env, job, network)).toBe('skipped');
        expect(network).toHaveBeenCalledTimes(1);
    });
    it('requires a verified identity binding, never a display-name match', async () => {
        const { job } = await queued('dm');
        const network = vi.fn(async () => response({ ok: true, team_id: 'TUNIT' }));
        expect(await deliverApprovalJob(env, job, network)).toBe('pending');
        expect(row('approval_delivery_outbox', job.id).last_error).toBe('verified_binding_unavailable');
        expect(network).toHaveBeenCalledTimes(1);
    });
    it.each(['channel','dm'])('does not treat two null production-line IDs as an eligible %s route',async(type)=>{
        const {job}=await queued(type);
        db.prepare("UPDATE system_settings SET value=? WHERE key='slack_delivery'").run(JSON.stringify({enabled:true,teamId:'TUNIT',dmEnabled:true,routes:[{projectId:'another-project',lineId:null,channelId:'CUNIT'}]}));
        const network=vi.fn(async()=>response({ok:true,team_id:'TUNIT'}));
        expect(await deliverApprovalJob(env,job,network)).toBe('skipped');
        expect(network).toHaveBeenCalledTimes(1);
        expect(row('approval_delivery_outbox',job.id).last_error).toBe('route_changed');
    });
    it('does not enqueue a DM for a project outside the configured routes',async()=>{
        db.prepare("INSERT INTO system_settings(workspace_id,key,value) VALUES('a','slack_delivery',?)").run(JSON.stringify({enabled:true,teamId:'TUNIT',dmEnabled:true,routes:[{projectId:'another-project',channelId:'CUNIT'}]}));
        await executeApprovalCommand(env,actor(),submit());
        expect(count('notifications')).toBe(1);
        expect(count('approval_delivery_outbox')).toBe(0);
    });
    it('skips a DM when its project route is removed after opening the conversation',async()=>{
        const {job}=await queued('dm');
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        const network=vi.fn(async(url)=>{
            const method=String(url).split('/').pop();
            if(method==='auth.test')return response({ok:true,team_id:'TUNIT'});
            if(method==='users.info')return response({ok:true,user:{id:'UUNIT',team_id:'TUNIT'}});
            if(method==='conversations.open'){
                db.exec("UPDATE system_settings SET value='{\"enabled\":true,\"teamId\":\"TUNIT\",\"dmEnabled\":true,\"routes\":[]}' WHERE key='slack_delivery'");
                return response({ok:true,channel:{id:'DUNIT'}});
            }
            throw new Error('must not post');
        });
        expect(await deliverApprovalJob(env,job,network)).toBe('skipped');
        expect(network).toHaveBeenCalledTimes(3);
        expect(row('approval_delivery_outbox',job.id).last_error).toBe('route_changed');
    });
    it('rechecks step authorization immediately before DM posting', async () => {
        const { job } = await queued('dm');
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        const network = vi.fn(async (url) => {
            const method = String(url).split('/').pop();
            if (method === 'auth.test')
                return response({ ok: true, team_id: 'TUNIT' });
            if (method === 'users.info') {
                db.exec("UPDATE members SET role='member' WHERE id='approver'");
                return response({ ok: true, user: { id: 'UUNIT', team_id: 'TUNIT' } });
            }
            if (method === 'conversations.open')
                return response({ ok: true, channel: { id: 'DUNIT' } });
            throw new Error('must not post');
        });
        expect(await deliverApprovalJob(env, job, network)).toBe('skipped');
        expect(network).toHaveBeenCalledTimes(3);
        expect(row('approval_delivery_outbox', job.id).last_error).toBe('recipient_changed');
    });
    it('uses a fixed 60-minute root window and handles exact boundary/future timestamps', () => {
        expect(approvalThread('1000.000001', 4599999)).toBe('1000.000001');
        expect(approvalThread('1000.000000', 4600000)).toBeUndefined();
        expect(approvalThread('5000.0', 4000000)).toBeUndefined();
    });
    it.each([
        "DELETE FROM external_account_bindings WHERE id='binding'",
        "UPDATE external_account_bindings SET platform_user_id='UOTHER' WHERE id='binding'",
        "UPDATE external_account_bindings SET verified_by=NULL WHERE id='binding'",
        "UPDATE external_account_bindings SET is_verified=0 WHERE id='binding'",
    ])('does not post a DM after its identity binding changes: %s',async(mutation)=>{
        const {job}=await queued('dm');
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        const network=vi.fn(async(url)=>{
            const method=String(url).split('/').pop();
            if(method==='auth.test')return response({ok:true,team_id:'TUNIT'});
            if(method==='users.info')return response({ok:true,user:{id:'UUNIT',team_id:'TUNIT'}});
            if(method==='conversations.open'){db.exec(mutation);return response({ok:true,channel:{id:'DUNIT'}});}
            throw new Error('must not post');
        });
        expect(await deliverApprovalJob(env,job,network)).toBe('skipped');
        expect(network).toHaveBeenCalledTimes(3);
        expect(row('approval_delivery_outbox',job.id).last_error).toBe('binding_changed');
    });
    it('rejects a users.info response for another Slack user',async()=>{
        const {job}=await queued('dm');
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        const network=vi.fn(async(url)=>String(url).endsWith('auth.test')?response({ok:true,team_id:'TUNIT'}):response({ok:true,user:{id:'UOTHER',team_id:'TUNIT'}}));
        expect(await deliverApprovalJob(env,job,network)).toBe('pending');
        expect(network).toHaveBeenCalledTimes(2);
        expect(row('approval_delivery_outbox',job.id).last_error).toBe('recipient_unavailable');
    });
    it.each([
        ["unproved email", "UPDATE members SET email_identity_verified=0 WHERE id='approver'; UPDATE external_account_bindings SET verified_by='email',verified_by_member_id=NULL WHERE id='binding'"],
        ["plain-admin issuer", "UPDATE external_account_bindings SET verified_by_member_id='approver' WHERE id='binding'"],
        ["inactive issuer", "UPDATE members SET is_active=0 WHERE id='super'"],
        ["paused mapping", "UPDATE external_account_bindings SET reconfirm_required=1 WHERE id='binding'"],
        ["banned login", "UPDATE auth_users SET banned=1 WHERE id='approver'"],
    ])('does not resolve a DM recipient for %s',async(_label,mutation)=>{
        const {job}=await queued('dm');
        db.exec("INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        db.exec(mutation);
        const network=vi.fn(async()=>response({ok:true,team_id:'TUNIT'}));
        expect(await deliverApprovalJob(env,job,network)).toBe('pending');
        expect(row('approval_delivery_outbox',job.id).last_error).toBe('verified_binding_unavailable');
        expect(network).toHaveBeenCalledTimes(1); // only team identity; no users.info/open/post
    });
    it('keeps deliberate live-owner mapping usable with an unproved login email',async()=>{
        const {job}=await queued('dm');
        db.exec("UPDATE members SET email_identity_verified=0 WHERE id='approver'; INSERT INTO external_account_bindings(workspace_id,id,member_id,platform,platform_user_id,platform_team_id,is_verified,verified_by,verified_by_member_id) VALUES('a','binding','approver','slack','UUNIT','TUNIT',1,'admin','super')");
        const network=vi.fn(async(url)=>{
            const method=String(url).split('/').pop();
            if(method==='auth.test')return response({ok:true,team_id:'TUNIT'});
            if(method==='users.info')return response({ok:true,user:{id:'UUNIT',team_id:'TUNIT'}});
            if(method==='conversations.open')return response({ok:true,channel:{id:'DUNIT'}});
            if(method==='chat.postMessage')return response({ok:true,ts:'1800000000.000001'});
            throw new Error('unexpected transport method');
        });
        expect(await deliverApprovalJob(env,job,network)).toBe('sent');
        expect(network).toHaveBeenCalledTimes(4);
        expect(row('members','approver').email_identity_verified).toBe(0);
    });
    it('retains subpath, uses title link and escapes mention-bearing content', () => {
        expect(approvalTaskUrl('http://localhost/app/', 'P-1')).toBe('http://localhost/app/?task=P-1');
        expect(() => approvalTaskUrl('javascript:alert(1)', 'P')).toThrow();
        const message = approvalDeliveryMessage({ operation: 'submit' }, { task_key: 'P-1', title: '<!here>', from_name: 'A', to_name: 'B' }, { status: 'pending', current_step: 1, steps_snapshot: [{}] }, 'https://example.test/app');
        expect(JSON.stringify(message.blocks)).toContain('&lt;!here&gt;');
        expect(message.text).toContain('&lt;!here&gt;');
        expect(message.text).not.toContain('<!here>');
        expect(JSON.stringify(message.blocks)).toContain('P-1');
        expect(message.blocks[1].elements[0].text.text).toBe('開啟 LIVO 簽核');
    });
});
