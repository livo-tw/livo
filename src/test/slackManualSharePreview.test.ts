// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleTaskUnfurl, type TaskUnfurlActions } from '../lib/slackTaskUnfurl';

type Row = Record<string, any>;
const appUrl = 'https://app.example.com';
const taskUrl = appUrl + '/?task=EX-12';
const qaId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const qaUrl = appUrl + '/?qa=' + qaId;
const project = { id: 'project-example', line_id: 'line-example', is_archived: false, name: 'Example' };
function fixture() {
  const channel = { id: 'CEXAMPLE', context_team_id: 'TEXAMPLE', is_channel: true, is_group: false,
    is_im: false, is_mpim: false, is_member: true, is_archived: false, is_shared: false,
    is_ext_shared: false, is_pending_ext_shared: false, shared_team_ids: ['TEXAMPLE'], pending_shared: [] as string[] };
  const config: Row = { enabled: true, teamId: 'TEXAMPLE', previewMode: 'internal_channels', routes: [], qaRoutes: [] };
  const payload = { type: 'event_callback', team_id: 'TEXAMPLE', event: { type: 'link_shared',
    source: 'conversations_history', channel: 'CEXAMPLE', user: 'UEXAMPLE', message_ts: '1234567890.123456', links: [{ url: taskUrl }, { url: qaUrl }] } };
  const slack = vi.fn(async (method: string, _body?: Row): Promise<Row> => method === 'conversations.info' ? { channel } : { ok: true });
  const actions = {
    appUrl, config: vi.fn(async () => config), slack,
    actor: vi.fn(async () => ({ id: 'member-example', team: 'TEXAMPLE', slack_user: 'UEXAMPLE' })),
    card: vi.fn(async () => ({ task: { id: 'task-example', task_key: 'EX-12', title: 'Safe <title> | <!channel>', project_id: project.id, status_id: 'status-example' }, project, status: { id: 'status-example', name: 'Ready' } })),
    qaCard: vi.fn(async () => ({ issue: { id: qaId, title: 'Example Bug', projectId: project.id }, project, stateLabel: 'New' })),
  } satisfies TaskUnfurlActions;
  const unfurls = () => slack.mock.calls.filter(([method]) => method === 'chat.unfurl').map(([, body]) => body!.unfurls);
  return { channel, config, payload, actions, slack, unfurls };
}

describe('explicit manual card sharing in internal Slack channels', () => {
  it('previews readable Task and Bug links without adding automatic notification routes', async () => {
    const f = fixture(); await handleTaskUnfurl(f.payload, f.actions);
    expect(Object.keys(f.unfurls()[0])).toEqual([taskUrl, qaUrl]);
    expect(f.config.routes).toEqual([]); expect(f.config.qaRoutes).toEqual([]);
    expect(f.slack.mock.calls.map(([method]) => method)).toEqual(['conversations.info', 'conversations.info', 'chat.unfurl']);
    const title = f.unfurls()[0][taskUrl].blocks.find((block: Row) => block.type === 'section' && block.text).text.text;
    expect(title).toBe('*<' + taskUrl + '|Safe &lt;title&gt; ｜ &lt;!channel&gt;>*');
  });
  it.each([undefined, 'project_routes', 'unknown', true])('keeps the existing route boundary for mode %s', async mode => {
    const f = fixture(); f.config.previewMode = mode;
    await handleTaskUnfurl(f.payload, f.actions); expect(f.unfurls()).toEqual([]);
    expect(f.actions.actor).not.toHaveBeenCalled();
  });
  it.each([
    { is_ext_shared: true }, { is_shared: true }, { is_pending_ext_shared: true }, { is_org_shared: true },
    { is_ext_ws_shared: true }, { connected_team_ids: ['TOTHER'] },
    { context_team_id: 'TOTHER' }, { is_shared: undefined }, { is_ext_shared: undefined },
    { is_pending_ext_shared: undefined }, { pending_shared: ['TOTHER'] }, { shared_team_ids: ['TOTHER'] },
    { pending_connected_team_ids: ['TOTHER'] }, { is_archived: true }, { is_frozen: true },
    { is_im: true }, { is_mpim: true }, { is_member: false },
  ])('denies an unknown, external or unavailable channel %j', async patch => {
    const f = fixture(); Object.assign(f.channel, patch);
    await handleTaskUnfurl(f.payload, f.actions); expect(f.unfurls()).toEqual([]);
  });
  it('rechecks a channel that starts external sharing while cards are being read', async () => {
    const f = fixture(); f.slack.mockResolvedValueOnce({ channel: { ...f.channel } }).mockResolvedValueOnce({ channel: { ...f.channel, is_pending_ext_shared: true } });
    await handleTaskUnfurl(f.payload, f.actions); expect(f.actions.card).toHaveBeenCalled(); expect(f.unfurls()).toEqual([]);
  });
  it('honors a sharing mode revoked during card reads', async () => {
    const f = fixture(); f.actions.config.mockResolvedValueOnce({ ...f.config }).mockResolvedValueOnce({ ...f.config, previewMode: 'project_routes' });
    await handleTaskUnfurl(f.payload, f.actions); expect(f.unfurls()).toEqual([]);
  });
  it('keeps a linked title within Slack limits even with a long canonical path and escaped text', async () => {
    const f = fixture(), base = appUrl + '/' + 'a'.repeat(1800);
    f.actions.appUrl = base;
    f.payload.event.links = [{ url: base + '/?task=EX-12' }];
    const card = await f.actions.card(); card.task.title = '&'.repeat(300); f.actions.card.mockResolvedValue(card);
    await handleTaskUnfurl(f.payload, f.actions);
    const title = Object.values(f.unfurls()[0])[0] as Row;
    const block = title.blocks.find((item: Row) => item.type === 'section' && item.text);
    expect(block.text.text.length).toBeLessThanOrEqual(3000);
    expect(block.text.text).toContain('&amp;'); expect(block.text.text.endsWith('>*')).toBe(true);
  });
  it('still requires the trusted actor and each readable card', async () => {
    const f = fixture(); f.actions.actor.mockResolvedValueOnce(undefined as never);
    await handleTaskUnfurl(f.payload, f.actions); expect(f.unfurls()).toEqual([]);
    f.actions.card.mockResolvedValueOnce(undefined as never); f.actions.qaCard.mockResolvedValueOnce(undefined as never);
    await handleTaskUnfurl(f.payload, f.actions); expect(f.unfurls()).toEqual([]);
  });
});
