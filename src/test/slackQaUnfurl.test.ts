// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleTaskUnfurl, qaFromUnfurlUrl, recordFromUnfurlUrl, type TaskUnfurlActions, type QaUnfurlCard } from '../lib/slackTaskUnfurl';
import { createTaskUnfurlActions } from '../../docker/volumes/functions/slack-interact/task-unfurl-backend';
import { DEFAULT_QA_WORKFLOW } from '../lib/qa/workflow';

type Row = Record<string, any>;
const appUrl = 'https://app.example.com';
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const url = appUrl + '/?qa=' + id;
const actor = { id: 'member-example', role: 'member', jwt: 'synthetic-session', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' };
const project = { id: 'project-example', name: 'Example project', line_id: 'line-example', is_archived: false };
const issue = { id, projectId: project.id, title: '<!channel> Wallet bug', state: 'verification',
  assigneeId: 'member-fixer', qaOwnerId: 'member-tester', priority: 2, severity: 'major', dueDate: '2026-12-01' };
const payload = () => ({ type: 'event_callback', team_id: 'TEXAMPLE', event: { type: 'link_shared',
  source: 'conversations_history', channel: 'CEXAMPLE', user: 'UEXAMPLE', message_ts: '1234567890.123456', links: [{ url }] } });
function adapter() {
  const qaCard = vi.fn(async (): Promise<QaUnfurlCard | undefined> => ({ issue, project, stateLabel: 'Waiting for QA',
    assigneeName: 'Example fixer', qaOwnerName: 'Example tester', priorityLabel: 'High', severityLabel: 'Major', dueDate: issue.dueDate }));
  const config = vi.fn(async (): Promise<Row> => ({ enabled: true, teamId: 'TEXAMPLE', routes: [],
    qaRoutes: [{ projectId: project.id, channelId: 'CEXAMPLE' }] }));
  const slack = vi.fn(async (method: string, _body?: Row): Promise<Row> => method === 'conversations.info'
    ? { channel: { id: 'CEXAMPLE', is_channel: true, is_im: false, is_mpim: false, is_member: true } } : { ok: true });
  return { appUrl, config, slack, actor: vi.fn(async () => actor), card: vi.fn(async () => undefined), qaCard };
}
const writes = (a: ReturnType<typeof adapter>) => a.slack.mock.calls.filter(([method]) => method === 'chat.unfurl');

describe('private QA link previews', () => {
  it('shows useful escaped QA fields without private descriptions, attachment URLs or identifiers', async () => {
    const a = adapter();
    a.qaCard.mockResolvedValue({ issue: { ...issue, actual: 'private actual', steps: 'private steps' }, project,
      stateLabel: 'Waiting for QA', assigneeName: 'Example <fixer>', qaOwnerName: 'Example tester',
      priorityLabel: 'High', severityLabel: 'Major', dueDate: issue.dueDate });
    await handleTaskUnfurl(payload(), a as TaskUnfurlActions);
    const body = writes(a)[0]?.[1];
    expect(body).toMatchObject({ channel: 'CEXAMPLE', ts: payload().event.message_ts });
    const text = JSON.stringify(body);
    for (const value of ['&lt;!channel&gt; Wallet bug', 'Example project', 'Waiting for QA', 'Example &lt;fixer&gt;',
      'Example tester', 'High', 'Major', '2026-12-01']) expect(text).toContain(value);
    for (const value of ['private actual', 'private steps', 'member-fixer', 'project-example', 'synthetic-session']) expect(text).not.toContain(value);
    expect(a.card).not.toHaveBeenCalled();
    expect(a.slack.mock.calls.map(([method]) => method)).toEqual(['conversations.info', 'chat.unfurl']);
  });
  it('uses QA routes independently of task routes', async () => {
    const a = adapter(), original = await a.config();
    a.config.mockResolvedValue({ ...original, routes: original.qaRoutes, qaRoutes: [] });
    await handleTaskUnfurl(payload(), a as TaskUnfurlActions);
    expect(writes(a)).toHaveLength(0); expect(a.qaCard).not.toHaveBeenCalled();
  });
  it.each([
    { enabled: false }, { teamId: 'TOTHER' }, { qaRoutes: [] },
    { qaRoutes: [{ projectId: project.id, channelId: 'COTHER' }] },
    { qaRoutes: [{ projectId: 'other-project', channelId: 'CEXAMPLE' }] },
    { qaRoutes: [{ projectId: project.id, channelId: 'CEXAMPLE', enabled: false }] },
  ])('does not publish with unapproved QA audience %j', async patch => {
    const a = adapter(); a.config.mockResolvedValue({ ...await a.config(), ...patch });
    await handleTaskUnfurl(payload(), a as TaskUnfurlActions); expect(writes(a)).toHaveLength(0);
  });
  it('supports a QA line route without widening to an archived or moved project', async () => {
    const a = adapter(); a.config.mockResolvedValue({ enabled: true, teamId: 'TEXAMPLE', qaRoutes: [{ lineId: project.line_id, channelId: 'CEXAMPLE' }] });
    await handleTaskUnfurl(payload(), a as TaskUnfurlActions); expect(writes(a)).toHaveLength(1);
    for (const card of [{ issue, project: { ...project, is_archived: true }, stateLabel: 'Waiting' },
      { issue: { ...issue, projectId: 'other-project' }, project, stateLabel: 'Waiting' }]) {
      a.slack.mockClear(); a.qaCard.mockResolvedValue(card);
      await handleTaskUnfurl(payload(), a as TaskUnfurlActions); expect(writes(a)).toHaveLength(0);
    }
  });
  it('rechecks QA audience after loading the card', async () => {
    const a = adapter(), original = await a.config();
    a.config.mockResolvedValueOnce(original).mockResolvedValue({ ...original, qaRoutes: [] });
    await handleTaskUnfurl(payload(), a as TaskUnfurlActions);
    expect(a.qaCard).toHaveBeenCalled(); expect(writes(a)).toHaveLength(0);
  });
  it.each([{ channel: 'DEXAMPLE' }, { source: 'composer' }, { source: 'unknown' }])('does not create a QA preview in unsafe context %j', async patch => {
    const a = adapter(), p = payload(); Object.assign(p.event, patch);
    await handleTaskUnfurl(p, a as TaskUnfurlActions); expect(a.actor).not.toHaveBeenCalled(); expect(writes(a)).toHaveLength(0);
  });
  it('requires a readable current issue with the exact identity', async () => {
    const a = adapter();
    for (const card of [undefined, { issue: { ...issue, id: 'other-issue' }, project, stateLabel: 'Waiting' }]) {
      a.qaCard.mockResolvedValue(card); await handleTaskUnfurl(payload(), a as TaskUnfurlActions);
      expect(writes(a)).toHaveLength(0);
    }
  });
  it('handles QA and task URLs with separate readers and route policies', async () => {
    const a = adapter(), p = payload() as Row;
    p.event.links.push({ url: appUrl + '/?task=EX-1' });
    await handleTaskUnfurl(p, a as TaskUnfurlActions);
    expect(a.card).toHaveBeenCalledWith(actor, 'EX-1');
    expect(Object.keys(writes(a)[0][1]!.unfurls)).toEqual([url]);
  });
  it('updates one message attachment on retries and never sends posts or DMs', async () => {
    const a = adapter(); await handleTaskUnfurl(payload(), a as TaskUnfurlActions); await handleTaskUnfurl(payload(), a as TaskUnfurlActions);
    expect(writes(a)).toHaveLength(2); expect(writes(a)[0]).toEqual(writes(a)[1]);
    expect(a.slack.mock.calls.every(([method]) => ['conversations.info', 'chat.unfurl'].includes(method))).toBe(true);
  });
  it.each([
    url + '&task=EX-1', url + '&qa=' + id, url + '&other=value', url + '#comment',
    'https://other.example.com/?qa=' + id, 'https://user:secret@app.example.com/?qa=' + id,
    'https://app.example.com/api/?qa=' + id, 'javascript:alert(1)',
  ])('rejects an ambiguous or untrusted QA URL %s', value => {
    expect(recordFromUnfurlUrl(value, appUrl)).toBeUndefined();
    expect(qaFromUnfurlUrl(value, appUrl)).toBeUndefined();
  });
  it('supports root, legacy and cloud paths', () => {
    expect(qaFromUnfurlUrl(url, appUrl)).toBe(id);
    expect(qaFromUnfurlUrl(appUrl + '/demo/?qa=' + id, appUrl)).toBe(id);
    expect(qaFromUnfurlUrl(appUrl + '/demo/?qa=' + id, appUrl + '/demo/')).toBe(id);
    expect(qaFromUnfurlUrl(url, appUrl + '/demo/')).toBeUndefined();
  });
});

describe('Docker QA unfurl reader', () => {
  function server() {
    const qa = { api: vi.fn(async (_actor: unknown, body: Row): Promise<any> => body.action === 'get'
      ? { issue, memberNames: { 'member-fixer': 'Example fixer', 'member-tester': 'Example tester' }, comments: [{ body: 'private' }], events: [], attachments: [] }
      : { ...DEFAULT_QA_WORKFLOW, labels: { ...DEFAULT_QA_WORKFLOW.labels, verification: 'Custom verification label' } }) };
    const rows = vi.fn(async () => [project]);
    const memberDb = vi.fn(() => ({ rows }));
    const a = createTaskUnfurlActions(appUrl, { qa, actor: vi.fn(async () => actor), task: vi.fn(), slack: vi.fn() }, memberDb, async () => ({}));
    return { a, qa, rows, memberDb };
  }
  it('uses the normal QA service and caller RLS for project labels', async () => {
    const { a, qa, memberDb } = server();
    const result = await a.qaCard!(actor, id);
    expect(qa.api).toHaveBeenCalledWith(actor, { action: 'get', id });
    expect(qa.api).toHaveBeenCalledWith(actor, { action: 'get_workflow' });
    expect(memberDb).toHaveBeenCalledWith(actor);
    expect(result).toMatchObject({ issue: { id, title: issue.title }, stateLabel: 'Custom verification label',
      assigneeName: 'Example fixer', qaOwnerName: 'Example tester' });
    expect(result?.issue).not.toHaveProperty('actual'); expect(result).not.toHaveProperty('comments');
  });
  it.each([400, 401, 403, 404])('does not return a card for denied or missing QA reads (%s)', async status => {
    const { a, qa } = server();
    qa.api.mockRejectedValue(Object.assign(new Error('qa_forbidden'), { status }));
    expect(await a.qaCard!(actor, id)).toBeUndefined();
  });
  it('does not use privileged fallback when the caller cannot read the project', async () => {
    const { a, rows } = server(); rows.mockResolvedValue([]);
    expect(await a.qaCard!(actor, id)).toBeUndefined();
  });
});
