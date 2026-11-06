// @vitest-environment node
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTaskUnfurl, isTaskUnfurlOpenPayload, type TaskUnfurlActions } from '../lib/slackTaskUnfurl';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';

// Worker code is checked by the Worker configuration, not the app DOM configuration.
const WORKER_HTTP = '../../worker/src/qaSlack';
const { handleQaSlackHttp } = await import(/* @vite-ignore */ WORKER_HTTP);

type Row = Record<string, any>;
const appUrl = 'https://app.example.com';
const taskUrl = `${appUrl}/?task=EX-12`;
const qaUrl = `${appUrl}/?qa=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`;
const project = { id: 'project-example', name: 'Example <Project>', line_id: 'line-example', is_archived: false };
const user = { id: 'member-example', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' };
function fixture(kind: 'task' | 'qa') {
  const task = { id: 'task-example', task_key: 'EX-12', title: 'Receipt <!channel> & preview',
    project_id: project.id, status_id: 'status-example', description: 'private-task-description' };
  const issue = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', projectId: project.id,
    title: 'Checkout <!here> & error', assigneeId: 'member-fixer', qaOwnerId: 'member-tester',
    actual: 'private-actual', steps: 'private-reproduction', attachmentUrl: 'https://private.example.com/download' };
  const taskCard = { task, project: { ...project }, status: { id: 'status-example', name: 'In progress' } };
  const qaCard = { issue, project: { ...project }, stateLabel: 'Waiting for QA',
    assigneeName: 'Example fixer', qaOwnerName: 'Example tester', priorityLabel: 'High', severityLabel: 'Major',
    dueDate: undefined as string | null | undefined };
  const slack = vi.fn(async (method: string, _body?: Row): Promise<Row> => method === 'conversations.info'
    ? { channel: { id: 'CEXAMPLE', is_channel: true, is_im: false, is_mpim: false, is_member: true } }
    : { ok: true });
  const actions: TaskUnfurlActions = {
    appUrl, actor: vi.fn(async () => user),
    config: vi.fn(async () => ({ enabled: true, teamId: 'TEXAMPLE',
      routes: [{ projectId: project.id, channelId: 'CEXAMPLE' }],
      qaRoutes: [{ projectId: project.id, channelId: 'CEXAMPLE' }] })),
    card: vi.fn(async () => taskCard), qaCard: vi.fn(async () => qaCard), slack,
  };
  const url = kind === 'task' ? taskUrl : qaUrl;
  const payload = { type: 'event_callback', team_id: 'TEXAMPLE', event: { type: 'link_shared',
    source: 'conversations_history', channel: 'CEXAMPLE', user: 'UEXAMPLE',
    message_ts: '1234567890.123456', links: [{ url }] } };
  const render = async (): Promise<Row> => {
    await handleTaskUnfurl(payload, actions);
    const write = slack.mock.calls.find(([method]) => method === 'chat.unfurl')?.[1];
    expect(write).toMatchObject({ channel: 'CEXAMPLE', ts: payload.event.message_ts });
    return write!.unfurls[url];
  };
  return { actions, slack, payload, taskCard, qaCard, url, render };
}
const fields = (attachment: Row): Row[] => attachment.blocks.flatMap((block: Row) => block.fields || []);
const fieldText = (attachment: Row) => fields(attachment).map(field => field.text).join('\n');
function assertSlackLimits(attachment: Row) {
  expect(attachment.blocks.length).toBeLessThanOrEqual(50);
  for (const block of attachment.blocks) {
    if (block.type === 'header') {
      expect(block.text.type).toBe('plain_text');
      expect(block.text.text.length).toBeLessThanOrEqual(150);
    }
    if (block.type === 'section') {
      if (block.text) expect(block.text.text.length).toBeLessThanOrEqual(3000);
      if (block.fields) {
        expect(block.fields.length).toBeLessThanOrEqual(10);
        for (const field of block.fields) expect(field.text.length).toBeLessThanOrEqual(2000);
      }
    }
    if (block.type === 'actions') {
      expect(block.elements).toHaveLength(1);
      expect(block.elements[0].text.text.length).toBeLessThanOrEqual(75);
      expect(block.elements[0].url.length).toBeLessThanOrEqual(3000);
    }
  }
}

afterEach(() => vi.unstubAllGlobals());

describe('structured Task and Bug unfurl cards', () => {
  it.each([
    ['task', '#3B82F6', 'LIVO · 任務 EX-12', 'Receipt &lt;!channel&gt; &amp; preview', '開啟任務'],
    ['qa', '#D97706', 'LIVO · Bug', 'Checkout &lt;!here&gt; &amp; error', '開啟 Bug'],
  ] as const)('renders a %s as a distinct card with safe navigation', async (kind, color, header, title, buttonText) => {
    const f = fixture(kind), attachment = await f.render();
    expect(attachment.color).toBe(color);
    expect(attachment.blocks.find((block: Row) => block.type === 'header')?.text.text).toBe(header);
    const titleBlock = attachment.blocks.find((block: Row) => block.type === 'section' && block.text);
    expect(titleBlock.text).toMatchObject({ type: 'mrkdwn', verbatim: true });
    expect(titleBlock.text.text).toContain(title);
    expect(attachment.blocks.some((block: Row) => block.type === 'divider')).toBe(true);
    expect(fieldText(attachment)).toContain('Example &lt;Project&gt;');
    expect(fieldText(attachment)).toContain(kind === 'task' ? 'In progress' : 'Waiting for QA');
    expect(fields(attachment)).toHaveLength(kind === 'task' ? 2 : 6);
    const buttons = attachment.blocks.filter((block: Row) => block.type === 'actions').flatMap((block: Row) => block.elements);
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ type: 'button', action_id: 'livo_unfurl_open_link', url: f.url,
      text: { type: 'plain_text', text: buttonText } });
    expect(buttons[0]).not.toHaveProperty('value');
    expect(attachment.fallback).toContain(title);
    expect(attachment.fallback).toContain('Example &lt;Project&gt;');
    const serialized = JSON.stringify(attachment);
    for (const privateValue of ['private-task-description', 'private-actual', 'private-reproduction',
      'https://private.example.com/download', 'member-example', 'member-fixer', 'member-tester', 'project-example']) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(f.slack.mock.calls.map(([method]) => method)).toEqual(['conversations.info', 'chat.unfurl']);
    assertSlackLimits(attachment);
  });

  it('keeps QA responsibility and classification in named fields', async () => {
    const attachment = await fixture('qa').render(), text = fieldText(attachment);
    for (const value of ['專案', '狀態', '修復', 'QA', '優先級', '嚴重度',
      'Example fixer', 'Example tester', 'High', 'Major']) expect(text).toContain(value);
    for (const field of fields(attachment)) expect(field).toMatchObject({ type: 'mrkdwn', verbatim: true });
  });

  it.each([undefined, null, ''])('omits a missing QA deadline (%s)', async dueDate => {
    const f = fixture('qa'); f.qaCard.dueDate = dueDate;
    const attachment = await f.render();
    expect(fields(attachment)).toHaveLength(6);
    expect(fieldText(attachment)).not.toContain('截止');
    expect(attachment.fallback).not.toContain('截止');
  });

  it('shows a deadline only when the saved QA card has one', async () => {
    const f = fixture('qa'); f.qaCard.dueDate = '2026-12-01';
    const attachment = await f.render();
    expect(fields(attachment)).toHaveLength(7);
    expect(fieldText(attachment)).toContain('截止');
    expect(fieldText(attachment)).toContain('2026-12-01');
    expect(attachment.fallback).toContain('2026-12-01');
  });

  it.each(['task', 'qa'] as const)('keeps the full supported %s title outside the short header', async kind => {
    const f = fixture(kind), title = '長'.repeat(300);
    if (kind === 'task') f.taskCard.task.title = title + 'hidden-tail';
    else f.qaCard.issue.title = title + 'hidden-tail';
    const attachment = await f.render();
    const titleBlock = attachment.blocks.find((block: Row) => block.type === 'section' && block.text);
    expect(titleBlock.text.text).toContain(title);
    expect(JSON.stringify(attachment)).not.toContain('hidden-tail');
    expect(attachment.blocks.find((block: Row) => block.type === 'header').text.text).not.toContain('長');
    assertSlackLimits(attachment);
  });

  it('normalizes hostile field lines and disables automatic mrkdwn interpretation', async () => {
    const f = fixture('qa');
    f.qaCard.project.name = 'Example\n<!channel>\tProject';
    f.qaCard.stateLabel = 'Waiting\r\n<!here>';
    f.qaCard.assigneeName = 'Example\n<@UEXAMPLE>';
    f.qaCard.qaOwnerName = 'QA\nInjected: owner';
    const attachment = await f.render();
    for (const field of fields(attachment)) {
      expect(field).toMatchObject({ type: 'mrkdwn', verbatim: true });
      expect(field.text.split('\n')).toHaveLength(2);
      expect(field.text).not.toMatch(/<!(?:channel|here)>|<@UEXAMPLE>/);
    }
    expect(fieldText(attachment)).toContain('Example &lt;!channel&gt; Project');
    expect(fieldText(attachment)).toContain('Waiting &lt;!here&gt;');
    expect(attachment.fallback).not.toMatch(/<!(?:channel|here)>|<@UEXAMPLE>/);
  });

  it('fits Slack limits even when escaping expands long user values', async () => {
    const f = fixture('task');
    f.taskCard.task.task_key = 'EXAMPLE'.repeat(100);
    f.taskCard.task.title = '<&>'.repeat(600);
    f.taskCard.project.name = '<&>'.repeat(600);
    f.taskCard.status.name = '<&>'.repeat(600);
    const attachment = await f.render();
    assertSlackLimits(attachment);
    for (const block of attachment.blocks.filter((b: Row) => b.type === 'section')) {
      const textObjects = [...(block.text ? [block.text] : []), ...(block.fields || [])];
      for (const text of textObjects) expect(text.text).not.toMatch(/&(?!amp;|lt;|gt;)/);
    }
  });
});

function openPayload(): Row {
  return { type: 'block_actions', is_app_unfurl: true,
    team: { id: 'TEXAMPLE' }, user: { id: 'UEXAMPLE' },
    container: { type: 'message_attachment', channel_id: 'CEXAMPLE', message_ts: '1234567890.123456' },
    actions: [{ type: 'button', action_id: 'livo_unfurl_open_link' }] };
}

describe('unfurl URL button acknowledgement', () => {
  it.each(['root', 'app_unfurl', 'container'] as const)('recognizes the %s Slack unfurl marker', marker => {
    const payload = openPayload(); delete payload.is_app_unfurl;
    if (marker === 'root') payload.is_app_unfurl = true;
    else if (marker === 'app_unfurl') payload.app_unfurl = { is_app_unfurl: true };
    else payload.container.is_app_unfurl = true;
    expect(isTaskUnfurlOpenPayload(payload)).toBe(true);
  });

  it.each([
    { is_app_unfurl: false },
    { container: { type: 'message' } },
    { type: 'view_submission' },
    { actions: [{ type: 'button', action_id: 'livo_task_open' }] },
    { actions: [{ type: 'button', action_id: 'livo_qa_edit' }] },
    { actions: [{ type: 'static_select', action_id: 'livo_unfurl_open_link' }] },
    { actions: [{ type: 'button', action_id: 'livo_unfurl_open_link' }, { type: 'button', action_id: 'livo_task_open' }] },
  ])('does not swallow another interaction %j', patch => {
    expect(isTaskUnfurlOpenPayload({ ...openPayload(), ...patch })).toBe(false);
  });

  it('ACKs Docker navigation before disabled features or unknown actor checks, with no backend access', async () => {
    const accessed: string[] = [];
    const actions = new Proxy({}, { get(_target, key) { accessed.push(String(key)); throw new Error('Unexpected backend access'); } });
    expect(await handleInteraction(openPayload(), 'example-envelope', actions as Actions)).toEqual({});
    expect(accessed).toEqual([]);
  });

  async function cloudRequest(payload: Row, format: string, validSignature = true) {
    const secret = 'synthetic-signing-secret';
    const body = format === 'application/json' ? JSON.stringify(payload) : new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${body}`).digest('hex');
    const db = vi.fn(() => { throw new Error('Unexpected database access'); });
    const waitUntil = vi.fn();
    const fetcher = vi.fn(() => { throw new Error('Unexpected HTTP request'); });
    vi.stubGlobal('fetch', fetcher);
    const headers: Record<string, string> = { 'content-type': format, 'content-length': String(Buffer.byteLength(body)),
      'x-slack-request-timestamp': timestamp, 'x-slack-signature': validSignature ? signature : 'v0=' + '0'.repeat(64) };
    const context = { req: { param: () => 'workspace-example', header: (name: string) => headers[name], text: async () => body },
      env: { SLACK_SIGNING_SECRET: secret, DB: { prepare: db } }, executionCtx: { waitUntil },
      json: (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }) };
    const response = await handleQaSlackHttp(context as never);
    return { response, db, waitUntil, fetcher };
  }

  it.each(['application/json', 'application/x-www-form-urlencoded'])('ACKs a signed Cloud navigation payload (%s) without side effects', async format => {
    const payload = openPayload(); delete payload.is_app_unfurl; payload.app_unfurl = { is_app_unfurl: true };
    const { response, db, waitUntil, fetcher } = await cloudRequest(payload, format);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({});
    expect(db).not.toHaveBeenCalled(); expect(waitUntil).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });

  it('still requires a valid Cloud signature before acknowledging a navigation button', async () => {
    const { response, db, waitUntil, fetcher } = await cloudRequest(openPayload(), 'application/json', false);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'invalid_signature' });
    expect(db).not.toHaveBeenCalled(); expect(waitUntil).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
  });
});
