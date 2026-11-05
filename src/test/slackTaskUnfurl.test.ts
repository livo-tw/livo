// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTaskUnfurl, taskFromUnfurlUrl, type TaskUnfurlActions } from '../lib/slackTaskUnfurl';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { createTaskUnfurlActions } from '../../docker/volumes/functions/slack-interact/task-unfurl-backend';
import { genericTaskOg } from '../../docker/volumes/functions/og-task/handler';

type Row = Record<string, any>;
const appUrl = 'https://app.example.com';
const url = `${appUrl}/?task=EX-12`;
const payload = () => ({ type: 'event_callback', team_id: 'TEXAMPLE', event: { type: 'link_shared',
  source: 'conversations_history', channel: 'CEXAMPLE', user: 'UEXAMPLE', message_ts: '1234567890.123456', links: [{ url }] } });
const card = () => ({ task: { id: 'task-example', task_key: 'EX-12', title: '<!channel> Example', project_id: 'project-a', status_id: 'status-a' },
  project: { id: 'project-a', name: 'Project <A>', line_id: 'line-a', is_archived: false }, status: { id: 'status-a', name: 'In progress' } });
function adapter() {
  const actor = vi.fn(async () => ({ id: 'member-a', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' }));
  const config = vi.fn(async (): Promise<Row> => ({ enabled: true, teamId: 'TEXAMPLE', routes: [{ projectId: 'project-a', channelId: 'CEXAMPLE' }] }));
  const read = vi.fn(async () => card());
  const slack = vi.fn(async (method: string, _body?: Row): Promise<Row> => method === 'conversations.info'
    ? { channel: { id: 'CEXAMPLE', is_channel: true, is_im: false, is_mpim: false, is_member: true } } : { ok: true });
  return { appUrl, actor, config, card: read, slack };
}
afterEach(() => vi.unstubAllGlobals());

describe('private task link unfurls', () => {
  it('builds only escaped title, number, project and status for the approved channel', async () => {
    const a = adapter(); await handleTaskUnfurl(payload(), a);
    expect(a.actor).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'UEXAMPLE', team_id: 'TEXAMPLE' }));
    const body = a.slack.mock.calls.find(([method]) => method === 'chat.unfurl')?.[1];
    expect(body).toMatchObject({ channel: 'CEXAMPLE', ts: payload().event.message_ts });
    const text = JSON.stringify(body);
    expect(text).toContain('EX-12'); expect(text).toContain('&lt;!channel&gt;'); expect(text).toContain('Project &lt;A&gt;');
    expect(text).toContain('In progress'); expect(text).not.toContain('member-a'); expect(text).not.toContain('project-a');
    expect(a.slack.mock.calls.map(([method]) => method)).toEqual(['conversations.info', 'chat.unfurl']);
  });
  it.each([
    ['off', { enabled: false }], ['wrong team', { teamId: 'TOTHER' }], ['no route', { routes: [] }],
    ['wrong channel', { routes: [{ projectId: 'project-a', channelId: 'COTHER' }] }],
    ['other project', { routes: [{ projectId: 'project-b', channelId: 'CEXAMPLE' }] }],
    ['disabled route', { routes: [{ projectId: 'project-a', channelId: 'CEXAMPLE', enabled: false }] }],
    ['QA route only', { routes: [], qaRoutes: [{ projectId: 'project-a', channelId: 'CEXAMPLE' }] }],
  ])('does not publish for %s', async (_label, patch) => {
    const a = adapter(), initial = await a.config(); a.config.mockResolvedValue({ ...initial, ...patch });
    await handleTaskUnfurl(payload(), a); expect(a.slack).not.toHaveBeenCalledWith('chat.unfurl', expect.anything());
  });
  it('accepts the existing line route and rejects archived or moved cards', async () => {
    const a = adapter(); a.config.mockResolvedValue({ enabled: true, teamId: 'TEXAMPLE', routes: [{ lineId: 'line-a', channelId: 'CEXAMPLE' }] });
    await handleTaskUnfurl(payload(), a); expect(a.slack).toHaveBeenCalledWith('chat.unfurl', expect.anything());
    for (const next of [{ ...card(), project: { ...card().project, is_archived: true } }, { ...card(), task: { ...card().task, project_id: 'project-b' } }]) {
      a.slack.mockClear(); a.card.mockResolvedValue(next); await handleTaskUnfurl(payload(), a);
      expect(a.slack).not.toHaveBeenCalledWith('chat.unfurl', expect.anything());
    }
  });
  it.each([{ source: 'composer', channel: 'COMPOSER' }, { channel: 'DEXAMPLE' }, { source: 'unknown' }, { message_ts: 'not-a-timestamp' }])('skips an unsafe event %j before resolving identities', async patch => {
    const a = adapter(), p = payload(); Object.assign(p.event, patch);
    await handleTaskUnfurl(p, a); expect(a.actor).not.toHaveBeenCalled(); expect(a.slack).not.toHaveBeenCalled();
  });
  it.each([{ is_mpim: true }, { is_im: true }, { is_member: false }, { id: 'COTHER' }])('denies a DM or mismatched/inaccessible conversation %j', async patch => {
    const a = adapter(); a.slack.mockResolvedValue({ channel: { id: 'CEXAMPLE', is_channel: true, is_im: false, is_mpim: false, is_member: true, ...patch } });
    await handleTaskUnfurl(payload(), a); expect(a.card).not.toHaveBeenCalled();
  });
  it('does not publish when the verified actor or readable card is missing', async () => {
    const a: TaskUnfurlActions = adapter(); a.actor = async () => undefined;
    await handleTaskUnfurl(payload(), a); expect(a.slack).not.toHaveBeenCalled();
    a.actor = adapter().actor; a.card = async () => undefined;
    await handleTaskUnfurl(payload(), a); expect(a.slack).not.toHaveBeenCalledWith('chat.unfurl', expect.anything());
  });
  it('keeps retries on the same message and never posts a new message or DM', async () => {
    const a = adapter(); await handleTaskUnfurl(payload(), a); await handleTaskUnfurl(payload(), a);
    const writes = a.slack.mock.calls.filter(([method]) => method === 'chat.unfurl');
    expect(writes).toHaveLength(2); expect(writes[0]).toEqual(writes[1]);
  });
  it('rechecks a route revoked during card reads before publishing', async () => {
    const a = adapter(), original = await a.config();
    a.config.mockResolvedValueOnce(original).mockResolvedValue({ ...original, routes: [] });
    await handleTaskUnfurl(payload(), a);
    expect(a.card).toHaveBeenCalled(); expect(a.slack).not.toHaveBeenCalledWith('chat.unfurl', expect.anything());
  });
  it('accepts Enterprise posted events without source only after checking the real channel', async () => {
    const a = adapter(), p: Row = payload(); delete p.event.source;
    await handleTaskUnfurl(p, a); expect(a.slack).toHaveBeenCalledWith('chat.unfurl', expect.anything());
  });
  it('dispatches link_shared before the QA event catch-all', async () => {
    const a = adapter(), qa = { enabled: vi.fn() };
    await handleInteraction(payload(), 'event-example', { taskUnfurl: a, qa } as unknown as Actions);
    expect(qa.enabled).not.toHaveBeenCalled(); expect(a.slack).toHaveBeenCalledWith('chat.unfurl', expect.anything());
  });
  it.each([
    ['https://other.example.com/?task=EX-12'], ['https://user:secret@app.example.com/?task=EX-12'],
    ['http://app.example.com/?task=EX-12'], [`${appUrl}/api/?task=EX-12`], [`${url}&task=EX-13`],
    [`${appUrl}/?task=x%2Cproject_id.neq.x`], ['javascript:alert(1)'],
    [`${url}&qa=other-card`], [`${url}#other-view`],
  ])('does not fetch or accept an untrusted URL %s', async value => {
    expect(taskFromUnfurlUrl(value, appUrl)).toBeUndefined();
    const a = adapter(), p = payload(); p.event.links = [{ url: value }];
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher); await handleTaskUnfurl(p, a);
    expect(fetcher).not.toHaveBeenCalled(); expect(a.actor).not.toHaveBeenCalled();
  });
  it('supports self-host root/legacy links and cloud /demo without accepting other app paths', () => {
    expect(taskFromUnfurlUrl(url, appUrl)).toBe('EX-12');
    expect(taskFromUnfurlUrl(`${appUrl}/demo/?task=EX-12`, appUrl)).toBe('EX-12');
    expect(taskFromUnfurlUrl(`${appUrl}/demo/?task=EX-12`, `${appUrl}/demo/`)).toBe('EX-12');
    expect(taskFromUnfurlUrl(url, `${appUrl}/demo/`)).toBeUndefined();
  });
});

describe('unfurl server adapters and anonymous OG', () => {
  it('reads related labels using the same caller database and never privileged card reads', async () => {
    const actor = { jwt: 'synthetic-session' }, task = vi.fn(async () => card().task);
    const rows = vi.fn(async (table: string) => [table === 'projects' ? card().project : card().status]);
    const memberDb = vi.fn(() => ({ rows }));
    const a = createTaskUnfurlActions(appUrl, { task, actor: async () => actor, slack: async () => ({}) }, memberDb, async () => ({}));
    expect(await a.card(actor, 'EX-12')).toEqual(card());
    expect(task).toHaveBeenCalledWith(actor, 'EX-12', true); expect(memberDb).toHaveBeenCalledWith(actor);
    expect(rows.mock.calls.map(([table]) => table)).toEqual(['projects', 'statuses']);
  });
  it('previews saved prefixed task IDs copied from the task-created toast', async () => {
    const actor = { jwt: 'synthetic-session' }, id = 't_12345678-1234-4234-8234-123456789abc';
    const saved = { ...card().task, id };
    const task = vi.fn(async (_actor: unknown, _reference: string, byKey?: boolean) => byKey ? undefined : saved);
    const rows = vi.fn(async (table: string) => [table === 'projects' ? card().project : card().status]);
    const a = createTaskUnfurlActions(appUrl, { task, actor: async () => actor, slack: async () => ({}) }, () => ({ rows }), async () => ({}));
    expect(await a.card(actor, id)).toEqual({ ...card(), task: saved });
    expect(task.mock.calls).toEqual([[actor, id, true], [actor, id]]);
    task.mockClear();
    expect(await a.card(actor, 'invalid,reference')).toBeUndefined();
    expect(task).not.toHaveBeenCalled();
  });
  it.each(['Slackbot-LinkExpanding 1.0', 'Mozilla/5.0', 'Twitterbot'])('never reads private cards for anonymous UA %s', async ua => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const response = genericTaskOg(new Request(`https://api.example.com/functions/v1/og-task?task=EX-12`, { headers: { 'user-agent': ua, 'x-forwarded-host': 'other.example.com' } }), appUrl);
    const text = await response.text();
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(text).toContain('登入 LIVO 以檢視此任務'); expect(text).toContain('https://app.example.com/?task=EX-12');
    expect(text).not.toContain('other.example.com'); expect(text).not.toContain('<!channel> Example'); expect(fetcher).not.toHaveBeenCalled();
  });
});
