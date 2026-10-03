import { createKnowledgeWorkData } from './knowledge-work-backend.ts';
import { createWorkData, executeSlackWorkCommand } from './work-backend.ts';
import { createReleaseData } from './release-backend.ts';
import { commentRecipients, convertMrkdwn, enabled, matchEmail, NO_ACCOUNT, option, projectOptionGroups, requiresWebCreate, taskOption, UNAVAILABLE, type Row } from './core.ts';
import { createApprovalData, executeSlackApprovalCommand } from './approval-backend.ts';
import { sourceOf, type Actions } from './handler.ts';
import { createWorkspaceData, WORKSPACE_ERRORS } from './workspace-backend.ts';
import { createKnowledgeData } from './knowledge-workspace.ts';
import { createTaskContextData } from './task-context.ts';
import { createPlanningData } from './planning-backend.ts';
import { TaskPlanningError } from './planning-core.ts';
import { KNOWLEDGE_SEARCH_SIZE, normalizeKnowledgeSearch } from './knowledge.ts';
export function fail(message: string): never { throw Object.assign(new Error(message), { name: 'ActionError' }); }
export interface Environment { get(name: string): string | undefined }
const encoder = new TextEncoder();
export async function constantTimeSecret(actual: string, expected: string) {
  const hashes = await Promise.all([actual, expected].map(s => crypto.subtle.digest('SHA-256', encoder.encode(s))));
  const [a, b] = hashes.map(h => new Uint8Array(h));
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return expected.length >= 32 && diff === 0;
}
export async function sign(secret: string, data: string) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(data)));
}
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
export async function memberJwt(secret: string, member: Row, binding: Row, source: Row = {}) {
  if (!secret || !member.auth_id || !binding.id || !binding.platform_team_id || !binding.platform_user_id) fail(NO_ACCOUNT);
  const now = Math.floor(Date.now() / 1000);
  const content = [{ alg: 'HS256', typ: 'JWT' }, { sub: member.auth_id, role: 'authenticated', aud: 'authenticated',
    email: member.email, iat: now, exp: now + 120, livo_slack_binding: binding.id, livo_slack_team: binding.platform_team_id, livo_slack_user: binding.platform_user_id, livo_slack_source: { channel: source.echoExistingMessage === false ? '' : source.channel || '', thread: source.thread || '' } }]
    .map(value => base64(encoder.encode(JSON.stringify(value)))).join('.');
  return `${content}.${base64(await sign(secret, content))}`;
}
export class Database {
  constructor(public env: Environment, public jwt = env.get('SUPABASE_SERVICE_ROLE_KEY') || '') {}
  async request(path: string, method = 'GET', body?: unknown, query: Row = {}, prefer = 'return=representation,resolution=merge-duplicates'): Promise<any> {
    const base = this.env.get('SUPABASE_URL');
    const res = await fetch(`${base}${path}?${new URLSearchParams(query)}`, { method,
      headers: { apikey: this.env.get('SUPABASE_ANON_KEY') || '', Authorization: `Bearer ${this.jwt}`,
        'Content-Type': 'application/json', Prefer: prefer },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      // Only translate stable application error keys; never expose raw SQL,
      // database details, or arbitrary upstream error messages to Slack.
      if (path === '/rest/v1/rpc/livo_slack_update' && typeof error?.message === 'string' && Object.prototype.hasOwnProperty.call(WORKSPACE_ERRORS, error.message))
        fail(WORKSPACE_ERRORS[error.message]);
      if (/^\/rest\/v1\/rpc\/livo_set_task_(deadline|reminder)$/.test(path) && typeof error?.message==='string' && /^planning_(forbidden|unavailable|conflict|invalid_input|invalid_date|invalid_kind|date_required|invalid_reason|reason_required|invalid_pause)$/.test(error.message)) throw new TaskPlanningError(error.message);
      throw new Error('Database operation failed');
    }
    return res.status === 204 ? null : res.json();
  }
  rows(table: string, query: Row = {}) { return this.request(`/rest/v1/${table}`, 'GET', undefined, query) as Promise<Row[]>; }
  write(table: string, body: unknown, query: Row = {}, method = 'POST') { return this.request(`/rest/v1/${table}`, method, body, query); }
  async setting(key: string) { return (await this.rows('system_settings', { select: 'value', key: `eq.${key}`, limit: '1' }))[0]?.value; }
}
/** Slack Web API calls with the bot token from slack_config (or SLACK_BOT_TOKEN). */
export function slackClient(env: Environment, admin = new Database(env)) {
  let tokenPromise: Promise<string> | undefined;
  const token = () => tokenPromise ??= (async () => {
    const row = (await admin.rows('slack_config', { select: 'bot_token', id: 'eq.singleton' }))[0];
    return row?.bot_token || env.get('SLACK_BOT_TOKEN') || fail('請管理員先連接 Slack Bot');
  })();
  return async (method: string, body: Row): Promise<Row> => {
    const read = ['users.info', 'users.list', 'chat.getPermalink'].includes(method);
    const res = await fetch(`https://slack.com/api/${method}${read ? '?' + new URLSearchParams(body) : ''}`, { method: read ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json; charset=utf-8' },
      ...(read ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(12000) });
    const result = await res.json();
    if (!res.ok || !result.ok) throw new Error('Slack operation failed');
    return result;
  };
}
export function createActions(env: Environment, background: (work: Promise<unknown>) => void): Actions {
  const admin = new Database(env);
  const slack = slackClient(env, admin);
  const memberDb = (actor: Row) => {
    if (!actor.jwt) fail(NO_ACCOUNT);
    return new Database(env, actor.jwt);
  };
  const getTask = async (actor: Row, id: string, byKey = false) => {
    const rows = await memberDb(actor).rows('tasks', {
      select: '*', [byKey ? 'task_key' : 'id']: `eq.${id}`, limit: byKey ? '2' : '1',
    });
    if (rows.length > 1) fail('找到多張相同卡號的卡片，請從搜尋結果依專案選擇。');
    return rows[0];
  };
  const actions: Actions = {
    enabled: async () => enabled(await admin.setting('feature_toggles')),
    heartbeat: async connected => { await admin.write('system_settings', { key: 'slack_socket_status',
      value: { connected, at: new Date().toISOString() }, updated_at: new Date().toISOString() }, { on_conflict: 'key' }); },
    actor: async p => {
      const user = p.user_id || p.user?.id, team = p.team_id || p.team?.id;
      if (!user || !team) fail(NO_ACCOUNT);
      const auth = await slack('auth.test', {});
      if (auth.team_id !== team) fail(NO_ACCOUNT);
      const info = (await slack('users.info', { user, include_locale: true })).user;
      if (!info || info.deleted || info.is_bot || info.is_restricted || info.is_ultra_restricted || (info.team_id && info.team_id !== team)) fail(NO_ACCOUNT);
      let binding = (await admin.rows('external_account_bindings', { select: '*', platform: 'eq.slack',
        platform_user_id: `eq.${user}`, platform_team_id: `eq.${team}`, limit: '1' }))[0];
      let member: Row | undefined;
      if (binding?.is_verified && binding.verified_by === 'admin') {
        // An admin assigned this Slack user to a member whose LIVO email differs.
        // Only the server writes verified_by (livo_guard_slack_binding).
        member = (await admin.rows('members', { select: '*', id: `eq.${binding.member_id}`, limit: '1' }))[0];
      } else {
        const email = info.profile?.email;
        if (typeof email !== 'string' || !email.trim()) fail(NO_ACCOUNT);
        const pattern = email.replace(/[\\%_]/g, (c: string) => '\\' + c);
        const candidates = await admin.rows('members', { select: '*', email: `ilike.${pattern}`, limit: '2' });
        member = matchEmail(candidates, email);
        // Old installations allowed members to edit their own binding rows. A
        // preexisting verified flag is never proof of Slack identity by itself.
        if (binding?.is_verified && binding.member_id !== member?.id) fail(NO_ACCOUNT);
      }
      if (!member || member.is_active !== true || !member.auth_id) fail(NO_ACCOUNT);
      const authUser = await admin.request(`/auth/v1/admin/users/${encodeURIComponent(member.auth_id)}`);
      if (authUser.deleted_at || (authUser.banned_until && Date.parse(authUser.banned_until) > Date.now())) fail(NO_ACCOUNT);
      if (!binding?.is_verified) binding = (await admin.write('external_account_bindings', { member_id: member.id, platform: 'slack',
        platform_user_id: user, platform_team_id: team, display_name: info.profile?.display_name || info.real_name || member.name,
        is_verified: true, verified_by: 'email' }, { on_conflict: 'platform,platform_user_id,platform_team_id' }))[0];
      if(binding.platform_team_id!==team || binding.platform_user_id!==user) fail(NO_ACCOUNT);
      return { ...member, timezone: info.tz || 'Asia/Taipei', binding_id: binding.id, team, slack_user: user, locale: info.locale || 'zh-TW',
        binding_verified_by: binding.verified_by, binding_verified_by_member_id: binding.verified_by_member_id,
        jwt: await memberJwt(env.get('JWT_SECRET') || '', member, binding, sourceOf(p)) };
    },
    catalog: async actor => {
      const db = memberDb(actor);
      const [projects, statuses, required] = await Promise.all([
        db.rows('projects', { select: 'id,name', is_archived: 'eq.false', order: 'name', limit: '1' }),
        db.rows('statuses', { select: 'id,name', order: 'sort_order,id', limit: '1' }), db.setting('required_fields'),
      ]);
      if (!projects.length || !statuses.length) fail('沒有可用的專案或狀態，請洽管理員');
      if (requiresWebCreate(required || {}))
        fail('團隊設有額外必填欄位，請在 LIVO 網頁建立卡片');
      return { projects, statuses, required };
    },
    search: async (actor, field, text) => {
      const db = memberDb(actor), query = text.replace(/[^\p{L}\p{N} _-]/gu, '').trim().slice(0, 100);
      const filter = query ? `*${query}*` : '*';
      if (field === 'task') return (await db.rows('tasks', { select: 'id,task_key,title',
        or: `(task_key.ilike.${filter},title.ilike.${filter})`, order: 'task_key', limit: '20' })).map(taskOption);
      if (field === 'project') {
        const [projects, lines] = await Promise.all([
          db.rows('projects', { select: 'id,name,line_id', name: `ilike.${filter}`, is_archived: 'eq.false', order: 'name,id', limit: '100' }),
          db.rows('product_lines', { select: 'id,name,sort_order', order: 'sort_order,id', limit: '100' }),
        ]);
        return projectOptionGroups(projects, lines, actor.locale);
      }
      const tables: Record<string, string> = { assignee: 'members', reviewer: 'members', status: 'statuses' };
      const table = tables[field];
      if (!table) return [];
      return (await db.rows(table, { select: 'id,name', name: `ilike.${filter}`, limit: '20',
        order: field === 'status' ? 'sort_order,id' : 'name',
        ...(['assignee', 'reviewer'].includes(field) ? { is_active: 'eq.true' } : {}) })).map(r => option(r.id, r.name));
    },
    workspace: createWorkspaceData(memberDb),
    knowledgeWork: createKnowledgeWorkData(env),
    releases: createReleaseData(env, memberDb),
    knowledge: createKnowledgeData(memberDb, env.get('APP_BASE_URL') || ''),
    taskContext: createTaskContextData(memberDb),
    approvals: createApprovalData(memberDb, (actor, command) => executeSlackApprovalCommand(env, actor, command)),
    planning: createPlanningData(memberDb),
    work: createWorkData(memberDb,(actor,command)=>executeSlackWorkCommand(env,actor,command)),
    task: getTask,
    mapped: async (actor, channel, ts) => {
      if (!channel || !ts) return;
      const mapping = (await admin.rows('slack_thread_mappings', { select: 'task_id', slack_team_id: `eq.${actor.team}`,
        slack_channel_id: `eq.${channel}`, slack_thread_ts: `eq.${ts}`, limit: '1' }))[0];
      return mapping && getTask(actor, mapping.task_id);
    },
    slack,
    reply: async (p, text, thread = false) => {
      const channel = p.channel_id || p.channel?.id, user = p.user_id || p.user?.id;
      if (!user) return;
      if (thread && channel) {
        try { await slack('chat.postMessage', { channel, thread_ts: p.thread || p.message?.thread_ts || p.message?.ts,
          text, unfurl_links: false, unfurl_media: false }); return; } catch { /* Fall back to a private receipt. */ }
      }
      if (channel) {
        try { await slack('chat.postEphemeral', { channel, user, text }); return; } catch { /* Bot may not be in channel. */ }
      }
      const dm = await slack('conversations.open', { users: user });
      await slack('chat.postMessage', { channel: dm.channel.id, text, unfurl_links: false });
    },
    commit: async (actor, kind, fields, requestId, source) => {
      if (!(await actions.enabled())) fail('LIVO 的 Slack 功能目前未啟用，請洽管理員');
      if (kind === 'create') await actions.catalog(actor);
      else if (!(await getTask(actor, fields.task_id))) fail(UNAVAILABLE);
      const raw = String(kind === 'create' ? fields.description || '' : fields.text || '');
      const mentions: Record<string, { id?: string; name: string }> = {};
      for (const id of [...new Set(raw.match(/<@[A-Z0-9]+>/g) || [])].slice(0, 40)) {
        const user = id.slice(2, -1);
        const binding = (await admin.rows('external_account_bindings', { select: 'member_id,display_name', platform: 'eq.slack',
          platform_team_id: `eq.${actor.team}`, platform_user_id: `eq.${user}`, is_verified: 'eq.true', limit: '1' }))[0];
        const member = binding && (await memberDb(actor).rows('members', { select: 'id,name', id: `eq.${binding.member_id}`, is_active: 'eq.true', limit: '1' }))[0];
        if (member) mentions[user] = { id: member.id, name: member.name };
        else {
          const info: Row = await slack('users.info', { user }).catch(() => ({}));
          mentions[user] = { name: info.user?.profile?.display_name || info.user?.real_name || 'Slack user' };
        }
      }
      const converted = convertMrkdwn(raw, mentions);
      if (kind === 'comment' && !converted.plain) fail('留言不可為空白');
      return memberDb(actor).request('/rest/v1/rpc/livo_slack_commit', 'POST', { p_request_id: requestId,
        p_kind: kind, p_fields: { ...fields, content: converted.html, preview: converted.plain.slice(0, 200), mentioned_ids: converted.mentionedIds },
        p_source: { channel: source.channel || '', thread: source.thread || '', team: actor.team } });
    },
    deliver: async (actor, result, source) => {
      const task = result.task, isComment = result.kind === 'comment';
      const targets = isComment ? commentRecipients(task, actor.id, result.mentioned_ids || []) : [];
      const members = targets.length ? await memberDb(actor).rows('members', { select: 'id,name,email', is_active: 'eq.true',
        id: `in.(${targets.map(t => t.id).join(',')})` }) : [];
      const payload = { type: isComment ? 'comment_added' : 'task_created', taskId: task.id, taskKey: task.task_key,
        taskTitle: task.title, priority: task.priority, actorName: actor.name, commentPreview: result.preview,
        sourceChannelId: isComment && source.echoExistingMessage !== false ? source.channel : undefined,
        dmTargets: members.map(m => ({ email: m.email, name: m.name, reason: targets.find(t => t.id === m.id)?.type === 'mention' ? '你被 @提及' : '你的任務有新留言' })) };
      // 20260714_notify_dispatch.sql already sends signed webhooks on task/comment
      // writes and emails on notification inserts. Do not dispatch them twice.
      await admin.request('/functions/v1/slack-notify', 'POST', payload);
    },
    background,
    link: task => `${(env.get('APP_BASE_URL') || '').replace(/\/$/, '')}/?task=${encodeURIComponent(task.task_key)}`,
  };
  actions.knowledgeSearch = {
    enabled: actions.enabled,
    actor: actions.actor,
    search: async (actor, input) => {
      const query = normalizeKnowledgeSearch(input);
      // The invoker RPC checks the live binding certificate as well as page RLS.
      const result = await memberDb(actor).request('/rest/v1/rpc/kb_slack_search', 'POST', {
        p_query: query.text, p_page: query.page, p_category: query.category,
      });
      return { pages: result.pages.slice(0, KNOWLEDGE_SEARCH_SIZE), hasMore: result.hasMore === true, page: query.page };
    },
    link: page => `${(env.get('APP_BASE_URL') || '').replace(/\/$/, '')}/?kb=${encodeURIComponent(page.id)}`,
    slack, background,
  };
  return actions;
}
