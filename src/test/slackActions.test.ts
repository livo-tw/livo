// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { canAssignSlackMember, slackEmailBelongsToOther, commentModal, commentRecipients, convertMrkdwn, createModal, DISABLED, enabled, matchEmail,
  messageDraft, NO_ACCOUNT, parseCommand, parseSubmission, projectOptionGroups, requiresWebCreate, shouldPostChannel, SLACK_LINK_DISABLED, taskReceipt,
  LOAD_BUDGET_MS, NO_PROJECT, NO_STATUS, replaceLoadingView, TRIGGER_EXPIRED, UNRESPONSIVE, withinBudget } from '../../docker/volumes/functions/slack-interact/core';
import { constantTimeSecret, createActions, fail, memberJwt } from '../../docker/volumes/functions/slack-interact/backend';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { resolveFeatureToggles } from '@/lib/featureToggles';
const actor = { id: 'member-example', name: 'Example Member', email: 'member@example.com', email_identity_verified: true, is_active: true,
  auth_id: '00000000-0000-4000-8000-000000000001', team: 'TEXAMPLE', jwt: 'member-session' };
const task = { id: 'task-example', task_key: 'ABC-123', title: 'Example card', project_id: 'project-example',
  assignee_id: 'member-assignee', reviewer_id: 'member-reviewer' };
const environment: Record<string, string> = { SUPABASE_URL: 'https://example.com', SUPABASE_SERVICE_ROLE_KEY: 'example-service',
  SUPABASE_ANON_KEY: 'example-anon', JWT_SECRET: 'example-only-secret-with-at-least-32-characters', APP_BASE_URL: 'https://example.com' };
const env = { get: (name: string) => environment[name] };
describe('Slack create required fields', () => {
  it('supports built-in title and project requirements alongside due date', () => {
    expect(requiresWebCreate({ title: true, project: true, dueDate: true, tags: false })).toBe(false);
    expect(requiresWebCreate({ title: true, project: true, status: true, priority: true, assignee: true, requirement: true })).toBe(false);
  });
  it.each(['reviewer', 'tags', 'startDate'])('still requires the web form for required %s', field => {
    expect(requiresWebCreate({ title: true, [field]: true })).toBe(true);
  });
});
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
function deps() {
  const jobs: Promise<unknown>[] = [];
  const d: Actions = { enabled: vi.fn(async () => true), heartbeat: vi.fn(async () => {}), actor: vi.fn(async () => actor),
    catalog: vi.fn(async () => ({ projects: [{ id: 'project-example', name: 'Example' }], statuses: [{ id: 'todo', name: 'Todo' }] })),
    search: vi.fn(async () => []), task: vi.fn(async () => task), mapped: vi.fn(async () => task),
    slack: vi.fn(async () => ({ view: { id: 'VEXAMPLE' }, permalink: 'https://example.com/message' })),
    reply: vi.fn(async () => {}), commit: vi.fn(async () => ({ task, kind: 'comment', duplicate: false })),
    deliver: vi.fn(async () => {}), background: job => { jobs.push(job); }, link: () => 'https://example.com/demo/?task=ABC-123' };
  return { d, jobs };
}
afterEach(() => vi.unstubAllGlobals());
describe('Slack project grouping and readable receipts', () => {
  const lines = [{ id: 'fish', name: 'Fish Game', sort_order: 2 }, { id: 'fast', name: 'Fast Game', sort_order: 1 }];
  const projects = [{ id: 'p-fish', name: 'Common', line_id: 'fish' }, { id: 'p-fast', name: 'Common', line_id: 'fast' },
    { id: 'p-none', name: 'Legacy', line_id: null }];
  it('keeps same-named projects distinct under the configured line order, with an unclassified fallback', () => {
    const groups = projectOptionGroups(projects, lines);
    expect(groups.map(g => g.label.text)).toEqual(['Fast Game', 'Fish Game', '未分類']);
    expect(groups.map(g => g.options[0].value)).toEqual(['p-fast', 'p-fish', 'p-none']);
    expect(projectOptionGroups([projects[0]], lines).map(g => g.label.text)).toEqual(['Fish Game']);
  });
  it('uses a grouped Slack response only for project suggestions', async () => {
    const { d } = deps(); const groups = projectOptionGroups(projects, lines);
    vi.mocked(d.search).mockResolvedValue(groups);
    expect(await handleInteraction({ type: 'block_suggestion', action_id: 'project', value: '' }, 'q', d))
      .toEqual({ option_groups: groups });
    vi.mocked(d.search).mockResolvedValue([]);
    expect(await handleInteraction({ type: 'block_suggestion', action_id: 'project', value: 'absent' }, 'q2', d))
      .toEqual({ options: [] });
  });
  it('loads active projects and line labels through member RLS and retains groups after searching', async () => {
    const fetchMock = vi.fn(async (url: string) => response(new URL(url).pathname.endsWith('/product_lines') ? lines : [projects[0]]));
    vi.stubGlobal('fetch', fetchMock);
    const groups = await createActions(env, () => {}).search(actor, 'project', 'Common');
    expect(groups.map(g => g.label.text)).toEqual(['Fish Game']);
    for (const [, init] of fetchMock.mock.calls as unknown as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer member-session');
    }
    const projectUrl = new URL(fetchMock.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/projects'))![0]);
    expect(projectUrl.searchParams.get('is_archived')).toBe('eq.false');
    expect(projectUrl.searchParams.get('name')).toBe('ilike.*Common*');
  });
  it('labels receipt links with the card key and title without allowing title text to inject links or mentions', () => {
    const receipt = taskReceipt('create', { ...task, title: 'UI <@UOTHER> & API | check' }, 'https://example.com/?task=ABC-123');
    expect(receipt).toBe('已建立卡片：\n<https://example.com/?task=ABC-123|ABC-123 - UI &lt;@UOTHER&gt; &amp; API ｜ check>');
    expect(taskReceipt('comment', { ...task, title: `"UI" & user's feedback` }, 'https://example.com/?task=ABC-123'))
      .toBe(`已新增留言：\n<https://example.com/?task=ABC-123|ABC-123 - "UI" &amp; user's feedback>`);
  });
  it('also uses a titled link for the direct comment command', async () => {
    const { d } = deps(); const payload = { command: '/livo', text: 'comment ABC-123 Example' };
    await handleInteraction(payload, 'request-receipt', d);
    expect(d.reply).toHaveBeenCalledWith(payload, taskReceipt('comment', task, d.link(task)));
  });
});
describe('Slack actions rules', () => {
  it.each([undefined, null, {}, { slackActions: 'true' }, { slackActions: 1 }, { slackActions: false }])('defaults OFF for %j', value => {
    expect(enabled(value)).toBe(false);
    expect(resolveFeatureToggles(value, { hasApprovalRules: true, hasApprovalRequests: true }).slackActions).toBe(false);
  });
  it('only enables explicit true', () => expect(enabled({ slackActions: true })).toBe(true));
  it('parses commands without losing multiline text', () => {
    expect(parseCommand('comment abc-123 first\nsecond')).toEqual({ kind: 'comment', key: 'ABC-123', text: 'first\nsecond' });
    expect(parseCommand('comment ABC-123')).toEqual({ kind: 'comment', key: 'ABC-123', text: '' });
    expect(parseCommand('new Example')).toEqual({ kind: 'new', text: 'Example' });
    expect(parseCommand('new API &lt;success&gt; &amp; latency')).toEqual({ kind: 'new', text: 'API <success> & latency' });
    expect(parseCommand('new Literal &amp;lt;tag&amp;gt;')).toEqual({ kind: 'new', text: 'Literal &lt;tag&gt;' });
    expect(parseCommand('nonsense')).toEqual({ kind: 'help' });
  });
  it('extracts the first line and keeps the message permalink', () => {
    expect(messageDraft({ text: '*Example*\nDetails' }, 'https://example.com/message')).toEqual({
      title: 'Example', description: '*Example*\nDetails\n\nhttps://example.com/message' });
    const long = messageDraft({ text: 'x'.repeat(4000) }, 'https://example.com/message');
    expect(long.description).toHaveLength(3000); expect(long.description.endsWith('https://example.com/message')).toBe(true);
  });
  it('matches email case-insensitively, rejects ambiguity and disabled members', () => {
    expect(matchEmail([actor], 'MEMBER@example.com')).toEqual(actor);
    expect(matchEmail([actor], 'missing@example.com')).toBeUndefined();
    expect(matchEmail([{ ...actor, is_active: false }], actor.email)).toBeUndefined();
    expect(matchEmail([actor, { ...actor, id: 'duplicate' }], actor.email)).toBeUndefined();
  });
  it('escapes HTML and uses editor mentions only for bound members', () => {
    const text = convertMrkdwn('*Hello* <@UBOUND> <@UOTHER> &lt;img src=x onerror=alert(1)&gt; <https://example.com|link> <!channel>', {
      UBOUND: { id: 'member-bound', name: 'Bound "Member"' }, UOTHER: { name: 'Other' } });
    expect(text.mentionedIds).toEqual(['member-bound']);
    expect(text.html).toContain('data-type="mention" data-id="member-bound"');
    expect(text.html).toContain('&lt;img'); expect(text.html).not.toContain('<img');
    expect(text.plain).toContain('@Other'); expect(text.plain).toContain('link (https://example.com)');
    expect(text.plain).not.toContain('<!channel>');
  });
  it('builds both modals with requester, status, task and message defaults', () => {
    const modal = createModal({ projects: [{ id: 'project-example', name: 'Example' }], statuses: [{ id: 'todo', name: 'Todo' }] }, actor,
      { title: 'Example', description: 'Details' });
    expect(modal.blocks.map(b => b.block_id)).toEqual(['title', 'project', 'status', 'assignee', 'priority', 'due', 'description']);
    expect(modal.blocks[3].element.initial_option.value).toBe(actor.id);
    expect(modal.blocks[2].element.initial_option.value).toBe('todo');
    expect(commentModal(task, 'Details').blocks[0].element.initial_option.value).toBe(task.id);
    expect(createModal({ projects: [], statuses: [] }, { ...actor, locale: 'en-US' }).blocks[0].label.text).toBe('Title');
    expect(createModal({ projects: [], statuses: [] }, { ...actor, locale: 'zh-CN' }).blocks[0].label.text).toBe('标题');
  });
  it('validates submissions, including impossible dates and missing text', () => {
    const values: Record<string, any> = {};
    for (const [key, value] of Object.entries({ title: 'Example', project: 'project-example', status: 'todo', assignee: actor.id, priority: 'medium', due: '2026-02-30' }))
      values[key] = { [key]: { value } };
    const parsed = parseSubmission({ callback_id: 'livo_create_task', state: { values } });
    expect(parsed.fields).toMatchObject({ title: 'Example', project_id: 'project-example', assignee_id: actor.id });
    expect(Object.keys(parsed.errors)).toEqual(['due']);
    expect(parseSubmission({ callback_id: 'livo_comment_task', state: {} }).errors).toHaveProperty('comment');
  });
  it('deduplicates notifications, excludes self and suppresses only the origin channel', () => {
    expect(commentRecipients(task, actor.id, [actor.id, 'member-assignee', 'member-mentioned'])).toEqual([
      { id: 'member-assignee', type: 'mention' }, { id: 'member-reviewer', type: 'comment' }, { id: 'member-mentioned', type: 'mention' }]);
    expect(shouldPostChannel('CEXAMPLE', 'CEXAMPLE')).toBe(false);
    expect(shouldPostChannel('COTHER', 'CEXAMPLE')).toBe(true);
    expect(shouldPostChannel('CEXAMPLE')).toBe(true);
  });
});
describe('interaction handler', () => {
  it.each([{ command: '/livo', text: 'new Example' }, { type: 'message_action', callback_id: 'livo_create_task' },
    { type: 'message_action', callback_id: 'livo_comment_task' }])('does no work when OFF: %j', async payload => {
    const { d } = deps(); vi.mocked(d.enabled).mockResolvedValue(false);
    await handleInteraction(payload, 'envelope-example', d);
    expect(d.reply).toHaveBeenCalledWith(payload, DISABLED);
    expect(d.actor).not.toHaveBeenCalled(); expect(d.commit).not.toHaveBeenCalled();
  });
  it('does not update the heartbeat, bind accounts or search while OFF', async () => {
    const { d } = deps(); vi.mocked(d.enabled).mockResolvedValue(false);
    await handleInteraction({ type: 'heartbeat', connected: true }, 'heartbeat', d);
    expect(await handleInteraction({ type: 'block_suggestion' }, 'suggestion', d)).toEqual({ options: [] });
    expect(d.heartbeat).not.toHaveBeenCalled(); expect(d.search).not.toHaveBeenCalled();
  });
  it('refuses unavailable cards without creating comments', async () => {
    const { d } = deps(); vi.mocked(d.task).mockResolvedValue(undefined);
    await handleInteraction({ command: '/livo', text: 'comment ABC-123 Example' }, 'request-example', d);
    expect(d.commit).not.toHaveBeenCalled(); expect(d.reply).toHaveBeenCalled();
  });
  it('opens a loading modal before binding and prefills a mapped thread', async () => {
    const { d } = deps();
    await handleInteraction({ type: 'message_action', callback_id: 'livo_comment_task', trigger_id: 'example-trigger',
      channel: { id: 'CEXAMPLE' }, user: { id: 'UEXAMPLE' }, message: { text: 'Example', ts: '2.0', thread_ts: '1.0' } }, 'request', d);
    expect(vi.mocked(d.slack).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.actor).mock.invocationCallOrder[0]);
    expect(d.mapped).toHaveBeenCalledWith(actor, 'CEXAMPLE', '1.0');
    const view = vi.mocked(d.slack).mock.calls.find(call => call[0] === 'views.update')![1].view;
    expect(view.blocks[0].element.initial_option.value).toBe(task.id);
    expect(view.blocks[1].element.initial_value).toContain('https://example.com/message');
  });
  it('ACKs a submission with a progress view and runs one transactional write', async () => {
    const { d, jobs } = deps();
    const result = await handleInteraction({ type: 'view_submission', user: { id: 'UEXAMPLE' }, team: { id: 'TEXAMPLE' },
      view: { id: 'VEXAMPLE', callback_id: 'livo_comment_task', private_metadata: '{}', state: { values: {
        task: { task: { selected_option: { value: task.id } } }, comment: { comment: { value: 'Example' } },
      } } } }, 'request', d);
    expect(result.response_action).toBe('update');
    await Promise.all(jobs);
    expect(d.commit).toHaveBeenCalledOnce(); expect(d.deliver).toHaveBeenCalledOnce();
    expect(vi.mocked(d.commit).mock.calls[0][3]).toBe('TEXAMPLE:VEXAMPLE');
    expect(vi.mocked(d.slack).mock.calls.find(([method]) => method === 'views.update')![1].view.blocks[0].text)
      .toEqual({ type: 'mrkdwn', text: taskReceipt('comment', task, d.link(task)) });
  });
  it('does not redeliver notifications for a replayed action', async () => {
    const { d } = deps(); vi.mocked(d.commit).mockResolvedValue({ task, duplicate: true });
    await handleInteraction({ command: '/livo', text: 'comment ABC-123 Example' }, 'request', d);
    expect(d.deliver).not.toHaveBeenCalled();
  });
});
describe('backend security and effects', () => {
  it('checks the internal secret without accepting an empty configuration', async () => {
    expect(await constantTimeSecret('x'.repeat(40), 'x'.repeat(40))).toBe(true);
    expect(await constantTimeSecret('y'.repeat(40), 'x'.repeat(40))).toBe(false);
    expect(await constantTimeSecret('', '')).toBe(false);
  });
  it('issues a short-lived authenticated member JWT, never a service role', async () => {
    const jwt = await memberJwt(env.get('JWT_SECRET')!, actor, { id: 'binding-example', platform_team_id: 'TEXAMPLE', platform_user_id: 'UEXAMPLE' });
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    expect(claims).toMatchObject({ role: 'authenticated', sub: actor.auth_id, livo_slack_binding: 'binding-example', livo_slack_team: 'TEXAMPLE', livo_slack_user: 'UEXAMPLE' });
    expect(claims.exp - claims.iat).toBe(120);
    await expect(memberJwt(env.get('JWT_SECRET')!, actor, { id: 'binding-missing' }, { team: 'TEXAMPLE', user: 'UEXAMPLE' })).rejects.toThrow(NO_ACCOUNT);
  });
  it('searches with member RLS and limits results to twenty without filter injection', async () => {
    const fetchMock = vi.fn(async () => response([task])); vi.stubGlobal('fetch', fetchMock);
    const options = await createActions(env, () => {}).search(actor, 'task', 'ABC),id.not.is.null');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).searchParams.get('limit')).toBe('20');
    expect(new URL(url).searchParams.get('or')).not.toContain('id.not.is.null');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer member-session');
    expect(options).toHaveLength(1);
  });
  it.each([{ members: [] }, { members: [{ ...actor, is_active: false }] }])('rejects unmatched or disabled accounts before binding', async ({ members }) => {
    const writes: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('slack_config')) return response([{ bot_token: 'example-bot' }]);
      if (url.endsWith('auth.test')) return response({ ok: true, team_id: 'TEXAMPLE' });
      if (new URL(url).pathname.endsWith('users.info')) return response({ ok: true, user: { team_id: 'TEXAMPLE', profile: { email: actor.email } } });
      if (url.includes('/members')) return response(members);
      if (init.method !== 'GET') writes.push(url);
      return response([]);
    }));
    await expect(createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' })).rejects.toThrow(NO_ACCOUNT);
    expect(writes).toEqual([]);
  });
  // A Slack backend fake: one bound Slack user (UEXAMPLE), a member list and recorded writes.
  function slackFake({ binding, members, slackEmail, unlinked = false }: { binding?: Record<string, unknown>; members: Record<string, unknown>[]; slackEmail: string; unlinked?: boolean }) {
    const writes: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (url.includes('slack_config')) return response([{ bot_token: 'example-bot' }]);
      if (path.endsWith('auth.test')) return response({ ok: true, team_id: 'TEXAMPLE' });
      if (path.endsWith('users.info')) return response({ ok: true, user: { id: 'UEXAMPLE', team_id: 'TEXAMPLE', profile: { email: slackEmail } } });
      if (path.includes('/auth/v1/admin/users/')) return response({ id: actor.auth_id });
      if (init.method && init.method !== 'GET') {
        writes.push({ url, body: JSON.parse(String(init.body)) });
        return response([{ id: 'binding-new', ...JSON.parse(String(init.body)) }]);
      }
      if (path.endsWith('/external_account_bindings')) return response(binding ? [{ platform_team_id: 'TEXAMPLE', platform_user_id: 'UEXAMPLE', ...binding }] : []);
      if (path.endsWith('/slack_link_preferences')) return response(unlinked ? [{ member_id: actor.id }] : []);
      if (path.endsWith('/members')) {
        const params = new URL(url).searchParams;
        const filter = (key: string) => params.get(key)?.replace(/^eq\./, '');
        const [id, role, active] = [filter('id'), filter('role'), filter('is_active')];
        return response(members.filter(m => (!id || m.id === id) && (!role || m.role === role) && (!active || String(m.is_active) === active)));
      }
      return response([]);
    }));
    return writes;
  }
  const owner = { id: 'member-owner', name: 'Example Owner', email: 'owner@example.com', email_identity_verified: true, role: 'super_admin', is_active: true, auth_id: '00000000-0000-4000-8000-000000000009' };
  const manual = (issuer?: string) => ({ id: 'binding-admin', platform_team_id: 'TEXAMPLE', platform_user_id: 'UEXAMPLE', member_id: actor.id,
    is_verified: true, verified_by: 'admin', ...(issuer === undefined ? {} : { verified_by_member_id: issuer }) });
  it('uses an admin-assigned binding even when the Slack email differs', async () => {
    const writes = slackFake({ slackEmail: 'personal@example.org', members: [actor, owner], binding: manual(owner.id) });
    const resolved = await createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' });
    expect(resolved).toMatchObject({ id: actor.id, binding_id: 'binding-admin' });
    expect(writes).toEqual([]);
  });
  it.each([
    ['a legacy mapping without an issuer', undefined, [actor, owner]],
    ['a mapping made by a plain admin', 'member-admin', [actor, owner, { ...owner, id: 'member-admin', role: 'admin' }]],
    ['a mapping whose owner was deactivated', owner.id, [actor, { ...owner, is_active: false }]],
    ['a mapping whose owner was demoted', owner.id, [actor, { ...owner, role: 'admin' }]],
    ['a mapping whose owner was removed', owner.id, [actor]],
  ])('treats %s as unbound and asks for an owner to map it again', async (_label, issuer, members) => {
    const writes = slackFake({ slackEmail: 'personal@example.org', members: members as Record<string, unknown>[], binding: manual(issuer as string | undefined) });
    await expect(createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' })).rejects.toThrow(NO_ACCOUNT);
    expect(writes).toEqual([]);
  });
  it('lets the Slack email prove identity again when an untrusted mapping matches it', async () => {
    const writes = slackFake({ slackEmail: actor.email, members: [actor, owner], binding: manual() });
    const resolved = await createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ member_id: actor.id, is_verified: true, verified_by: 'email' });
    expect(resolved).toMatchObject({ id: actor.id, binding_verified_by: 'email' });
  });
  it('never trusts a verified binding without the server admin marker when emails differ', async () => {
    slackFake({ slackEmail: 'personal@example.org', members: [actor],
      binding: { id: 'binding-old', member_id: actor.id, is_verified: true, verified_by: null } });
    await expect(createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' })).rejects.toThrow(NO_ACCOUNT);
  });
  it('still refuses a deactivated member behind an admin-assigned binding', async () => {
    slackFake({ slackEmail: 'personal@example.org', members: [{ ...actor, is_active: false }, owner], binding: manual(owner.id) });
    await expect(createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' })).rejects.toThrow(NO_ACCOUNT);
  });
  it.each([
    ['an email match', undefined],
    ['an owner-assigned binding', 'admin'],
  ])('refuses %s for a member who unlinked Slack in My settings, without binding again', async (_label, kind) => {
    const writes = slackFake({ slackEmail: kind ? 'personal@example.org' : actor.email, members: [actor, owner], binding: kind ? manual(owner.id) : undefined, unlinked: true });
    const failure = await createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' }).catch((error: Error & { code?: string }) => error);
    expect(failure).toMatchObject({ message: SLACK_LINK_DISABLED, code: 'no_account' });
    expect(writes).toEqual([]);
  });
  it('marks a first-time email match as verified by email', async () => {
    const writes = slackFake({ slackEmail: actor.email, members: [actor] });
    await createActions(env, () => {}).actor({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' });
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toMatchObject({ member_id: actor.id, is_verified: true, verified_by: 'email' });
  });
  it('restricts identity assignment to owners, including member-role accounts protected by job-title ACLs', () => {
    const member = { id: 'm1', role: 'member', is_active: true, auth_id: 'a1' };
    const otherAdmin = { id: 'a2', role: 'admin', is_active: true, auth_id: 'a2' };
    const superAdmin = { id: 's1', role: 'super_admin', is_active: true, auth_id: 's1' };
    const admin = { id: 'a1', role: 'admin' };
    expect(canAssignSlackMember(admin, { ...member, job_title: 'Product' })).toBe(false);
    expect(canAssignSlackMember(admin, { ...otherAdmin, id: 'a1' })).toBe(false);
    expect(canAssignSlackMember(admin, otherAdmin)).toBe(false);
    expect(canAssignSlackMember(admin, superAdmin)).toBe(false);
    expect(canAssignSlackMember({ id: 's1', role: 'super_admin' }, otherAdmin)).toBe(true);
    expect(canAssignSlackMember({ id: 's1', role: 'super_admin' }, { ...member, is_active: false })).toBe(false);
    expect(canAssignSlackMember({ id: 's1', role: 'super_admin' }, { ...member, auth_id: null })).toBe(false);
    expect(canAssignSlackMember({ id: 'x', role: 'member' }, member)).toBe(false);
    expect(canAssignSlackMember(admin, undefined)).toBe(false);
  });
  it('refuses to map a Slack account whose email already identifies another member', () => {
    const owners = [{ id: 'admin-self', email: 'Admin@Example.com', email_identity_verified: true }, { id: 'member-off', email: 'off@example.com', email_identity_verified: true }];
    // An admin cannot hand their own Slack account to a plain member…
    expect(slackEmailBelongsToOther(owners, 'admin@example.com', 'member-plain')).toBe(true);
    // …nor reuse a deactivated member's address.
    expect(slackEmailBelongsToOther(owners, 'off@example.com', 'member-plain')).toBe(true);
    // The real case: a Slack email that matches nobody, or matches the target.
    expect(slackEmailBelongsToOther(owners, 'personal@example.org', 'member-plain')).toBe(false);
    expect(slackEmailBelongsToOther(owners, 'admin@example.com', 'admin-self')).toBe(false);
    expect(slackEmailBelongsToOther(owners, '', 'member-plain')).toBe(false);
    expect(slackEmailBelongsToOther(owners, undefined, 'member-plain')).toBe(false);
  });
  it('stores how a binding was verified in a constrained, server-only column', () => {
    const migration = readFileSync(new URL('../../supabase/migrations/20261002_slack_manual_binding.sql', import.meta.url), 'utf8');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS verified_by text');
    expect(migration).toContain("verified_by IN ('email', 'admin')");
  });
  it('leaves signed webhooks and email to the existing SQL triggers', () => {
    const migration = readFileSync(new URL('../../supabase/migrations/20261002_slack_actions.sql', import.meta.url), 'utf8');
    expect(migration).toContain('SECURITY INVOKER');
    expect(migration).toContain('comment_count=comment_count+1');
    expect(migration).toContain("'comment_add'"); expect(migration).toContain("'slack'");
    const dispatch = readFileSync(new URL('../../supabase/migrations/20260714_notify_dispatch.sql', import.meta.url), 'utf8');
    expect(dispatch).toContain('AFTER INSERT ON public.comments');
  });
});
// Reported from a team server: `/livo new` opened a modal that stayed on
// 「正在載入 LIVO…」 forever. Every failure after views.open must replace it.
describe('the /livo new loading modal never hangs', () => {
  const slackError = (code: string) => Object.assign(new Error('Slack operation failed'), { name: 'SlackApiError', slackError: code });
  const updates = (d: Actions) => vi.mocked(d.slack).mock.calls.filter(([method]) => method === 'views.update').map(([, body]) => body);
  const shownText = (d: Actions) => updates(d).at(-1)?.view.blocks[0].text?.text;
  const payload = { command: '/livo', text: 'new Example', trigger_id: 'example-trigger', user_id: 'UEXAMPLE', team_id: 'TEXAMPLE', channel_id: 'CEXAMPLE' };
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  it('replaces the loading modal with a retry message when Slack rejects the create form', async () => {
    const { d } = deps(); vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(d.slack).mockImplementation(async (method, body) => {
      if (method === 'views.update' && body.view.callback_id === 'livo_create_task') throw slackError('invalid_arguments');
      return { view: { id: 'VEXAMPLE' } };
    });
    expect(await handleInteraction(payload, 'rejected', d)).toEqual({});
    expect(updates(d).map(body => body.view.callback_id)).toEqual(['livo_create_task', 'livo_result']);
    expect(updates(d).every(body => body.view_id === 'VEXAMPLE')).toBe(true);
    expect(shownText(d)).toBe(UNRESPONSIVE);
    expect(d.reply).not.toHaveBeenCalled();
  });
  it('stops waiting for a slow account or catalog lookup and says so before the edge worker is stopped', async () => {
    vi.useFakeTimers();
    const { d } = deps(); vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(d.catalog).mockImplementation(() => new Promise(() => {}));
    const pending = handleInteraction(payload, 'slow', d);
    await vi.advanceTimersByTimeAsync(LOAD_BUDGET_MS - 1);
    expect(updates(d)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({});
    expect(shownText(d)).toBe(UNRESPONSIVE);
    expect(console.error).toHaveBeenCalledWith('slack_form_load_failed reason=TimeoutError');
    expect(LOAD_BUDGET_MS + 12000).toBeLessThan(30000); // load + one Slack call fit in the worker's 30 s minimum
  });
  it.each([
    ['an unbound Slack account', () => fail(NO_ACCOUNT), NO_ACCOUNT],
    ['no project to create a card in', () => fail(NO_PROJECT), NO_PROJECT],
    ['a Slack or database outage', () => { throw slackError('ratelimited'); }, UNRESPONSIVE],
  ])('explains %s in the modal instead of loading forever', async (_, failure, text) => {
    const { d } = deps(); vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(d.catalog).mockImplementation(async () => failure());
    await handleInteraction(payload, 'explained', d);
    expect(updates(d)).toHaveLength(1); expect(shownText(d)).toBe(text);
  });
  it('translates the reason for the person once their Slack locale is known', async () => {
    const { d } = deps(); vi.mocked(d.actor).mockResolvedValue({ ...actor, locale: 'en-US' });
    vi.mocked(d.catalog).mockImplementation(async () => fail(NO_PROJECT));
    await handleInteraction(payload, 'english', d);
    expect(shownText(d)).toMatch(/^There is no project to create a card in/);
  });
  it('leaves a closed modal alone and falls back to a private message only when nothing can be shown', async () => {
    const closed = deps();
    vi.mocked(closed.d.slack).mockImplementation(async method => { if (method === 'views.update') throw slackError('not_found'); return { view: { id: 'VEXAMPLE' } }; });
    await handleInteraction(payload, 'closed', closed.d);
    expect(updates(closed.d)).toHaveLength(1); expect(closed.d.reply).not.toHaveBeenCalled();
    const broken = deps();
    vi.mocked(broken.d.slack).mockImplementation(async method => { if (method === 'views.update') throw slackError('internal_error'); return { view: { id: 'VEXAMPLE' } }; });
    await handleInteraction(payload, 'broken', broken.d);
    expect(updates(broken.d)).toHaveLength(2); expect(broken.d.reply).toHaveBeenCalledWith(payload, UNRESPONSIVE);
  });
  it('asks to run the command again when the trigger expired before the modal opened', async () => {
    const { d } = deps();
    vi.mocked(d.slack).mockRejectedValue(slackError('expired_trigger_id'));
    await handleInteraction(payload, 'expired', d);
    expect(d.actor).not.toHaveBeenCalled(); expect(d.reply).toHaveBeenCalledWith(payload, TRIGGER_EXPIRED);
  });
  it('shows the plain receipt when Slack rejects the detail view after saving', async () => {
    const { d, jobs } = deps();
    vi.mocked(d.slack).mockImplementation(async (method, body) => {
      if (method === 'views.update' && body.view.callback_id !== 'livo_result') throw slackError('invalid_arguments');
      return { view: { id: 'VEXAMPLE' } };
    });
    d.workspace = { detail: vi.fn(async () => task), comments: vi.fn(async () => ({ comments: [], page: 0, hasMore: false })),
      list: vi.fn(), update: vi.fn() };
    await handleInteraction({ type: 'view_submission', user: { id: 'UEXAMPLE' }, team: { id: 'TEXAMPLE' },
      view: { id: 'VEXAMPLE', callback_id: 'livo_comment_task', private_metadata: '{}', state: { values: {
        task: { task: { selected_option: { value: task.id } } }, comment: { comment: { value: 'Example' } } } } } }, 'saved', d);
    await Promise.all(jobs);
    expect(updates(d).map(body => body.view.callback_id)).toEqual(['livo_task_detail', 'livo_result']);
    expect(shownText(d)).toBe(taskReceipt('comment', task, d.link(task)));
  });
  it('replaceLoadingView never overwrites a newer view or a possibly applied update', async () => {
    for (const code of ['hash_conflict', 'not_found', 'timeout', 'unreachable']) {
      const slack = vi.fn(async () => { throw slackError(code); });
      expect(await replaceLoadingView(slack, 'VEXAMPLE', { type: 'modal' }, { type: 'fallback' }, 'hash-example')).toBe('left');
      expect(slack).toHaveBeenCalledOnce();
      expect(slack).toHaveBeenCalledWith('views.update', { view_id: 'VEXAMPLE', hash: 'hash-example', view: { type: 'modal' } });
    }
    expect(await replaceLoadingView(vi.fn(), undefined, {}, {})).toBe('failed');
    await expect(withinBudget(Promise.resolve('loaded'), 10)).resolves.toBe('loaded');
  });
});
describe('Slack Web API failures are logged with their code, never the token or content', () => {
  afterEach(() => vi.restoreAllMocks());
  it('logs the method, Slack error code and validation pointers', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url.includes('slack_config') ? response([{ bot_token: 'example-bot-token' }])
      : response({ ok: false, error: 'invalid_arguments', response_metadata: { messages: ['[ERROR] must be less than 76 characters [json-pointer:/view/blocks/1/element/initial_option/text/text]'] } })));
    const slack = createActions(env, () => {}).slack;
    const error = await slack('views.update', { view_id: 'VEXAMPLE', view: { title: 'Secret customer title' } }).catch(e => e);
    expect(error).toMatchObject({ name: 'SlackApiError', slackError: 'invalid_arguments', message: 'Slack operation failed' });
    const line = String(log.mock.calls[0][0]);
    expect(line).toContain('slack_api_error method=views.update error=invalid_arguments');
    expect(line).toContain('json-pointer:/view/blocks/1/element/initial_option/text/text');
    expect(line).not.toContain('example-bot-token'); expect(line).not.toContain('Secret customer title');
  });
  it('reports a missing scope and a Slack timeout by code', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    let timeout = false;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('slack_config')) return response([{ bot_token: 'example-bot-token' }]);
      if (timeout) throw new DOMException('The operation timed out.', 'TimeoutError');
      return response({ ok: false, error: 'missing_scope', needed: 'users:read.email', provided: 'commands,chat:write' });
    }));
    const slack = createActions(env, () => {}).slack;
    await expect(slack('users.info', { user: 'UEXAMPLE' })).rejects.toMatchObject({ slackError: 'missing_scope' });
    expect(log).toHaveBeenLastCalledWith('slack_api_error method=users.info error=missing_scope needed=users:read.email');
    timeout = true;
    await expect(slack('views.update', { view_id: 'VEXAMPLE' })).rejects.toMatchObject({ slackError: 'timeout' });
    expect(log).toHaveBeenLastCalledWith('slack_api_error method=views.update error=timeout');
  });
  it('splits the catalog reasons so the modal can say which one applies', async () => {
    const lookup = (projects: unknown[], statuses: unknown[]) => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        const path = new URL(url).pathname;
        return response(path.endsWith('/projects') ? projects : path.endsWith('/statuses') ? statuses : []);
      }));
      return createActions(env, () => {}).catalog(actor);
    };
    await expect(lookup([], [{ id: 'todo', name: 'Todo' }])).rejects.toThrow(NO_PROJECT);
    await expect(lookup([{ id: 'project-example', name: 'Example' }], [])).rejects.toThrow(NO_STATUS);
  });
});
