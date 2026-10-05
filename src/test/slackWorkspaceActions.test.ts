// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleInteraction, sourceOf, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { memberJwt } from '../../docker/volumes/functions/slack-interact/backend';
import { editModal } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import { notificationMessage } from '../../docker/volumes/functions/slack-deliver/core';
import type { Row } from '../../docker/volumes/functions/slack-interact/core';

const actor = { id: 'member-example', name: 'Example Member', team: 'TEXAMPLE', slack_user: 'UEXAMPLE', locale: 'zh-TW', jwt: 'member-session' };
const task: Row = { id: 'task-example', task_key: 'ABC-123', title: 'Example card', status_id: 'todo',
  assignee_id: actor.id, reviewer_id: null, due_date: null, priority: 'medium' };
const source = { team: actor.team, user: actor.slack_user, channel: 'CEXAMPLE', thread: '123.001', locale: 'zh-TW' };
const base = { team: { id: actor.team }, user: { id: actor.slack_user }, trigger_id: 'trigger-example' };
const submission = () => ({ ...base, type: 'view_submission', view: { ...editModal(task, source), id: 'VEXAMPLE', hash: 'hash-first',
  state: { values: { priority: { priority: { selected_option: { value: 'high' } } } } } } });
function setup() {
  const jobs: Promise<unknown>[] = [];
  const d: Actions = {
    enabled: vi.fn(async () => true), heartbeat: vi.fn(async () => {}), actor: vi.fn(async () => actor),
    catalog: vi.fn(async () => ({ projects: [{ id: 'project', name: 'Project' }], statuses: [{ id: 'todo', name: 'Todo' }] })),
    search: vi.fn(async () => []), task: vi.fn(async () => task), mapped: vi.fn(async () => task),
    slack: vi.fn(async () => ({ view: { id: 'VEXAMPLE', hash: 'hash-loading' } })), reply: vi.fn(async () => {}),
    commit: vi.fn(async () => ({ kind: 'comment', task, duplicate: false })), deliver: vi.fn(async () => {}),
    background: work => { jobs.push(work); }, link: () => 'https://example.com/?task=ABC-123',
    workspace: { list: vi.fn(async () => ({ tasks: [task], page: 0, hasMore: true })), detail: vi.fn(async () => task),
      comments: vi.fn(async () => ({ comments: [], page: 0, hasMore: false })),
      update: vi.fn(async () => ({ kind: 'update', task: { ...task, priority: 'high' }, duplicate: false })) },
  };
  return { d, jobs, flush: async () => { await Promise.all(jobs); },
    lastView: () => vi.mocked(d.slack).mock.calls.filter(([method]) => method === 'views.update').at(-1)?.[1].view };
}

describe('Slack daily task workspace', () => {
  it('opens the home panel and consumes the trigger before account lookup, without posting query contents', async () => {
    const { d, flush, lastView } = setup();
    expect(await handleInteraction({ ...base, command: '/livo', text: '' }, 'request', d)).toEqual({});
    await flush();
    expect(vi.mocked(d.slack).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.actor).mock.invocationCallOrder[0]);
    expect(lastView().callback_id).toBe('livo_workspace_home');
    expect(d.reply).not.toHaveBeenCalled(); expect(d.commit).not.toHaveBeenCalled();
  });
  it('ACKs while slow query work is still pending and protects modal replacement with hashes', async () => {
    const { d, flush, lastView } = setup(); let finish!: (value: any) => void;
    vi.mocked(d.workspace!.list).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const payload = { ...base, type: 'block_actions', view: { id: 'VEXAMPLE', hash: 'hash-list', private_metadata: JSON.stringify(source) },
      actions: [{ action_id: 'livo_tasks_page', value: JSON.stringify({ kind: 'my', page: 1 }) }] };
    expect(await handleInteraction(payload, 'page', d)).toEqual({});
    expect(d.slack).toHaveBeenCalledWith('views.update', expect.objectContaining({ hash: 'hash-list' }));
    finish({ tasks: [task], page: 1, hasMore: false }); await flush();
    expect(d.workspace!.list).toHaveBeenCalledWith(actor, { kind: 'my', page: 1 });
    expect(lastView().callback_id).toBe('livo_task_list');
    expect(vi.mocked(d.slack).mock.calls.at(-1)?.[1].hash).toBe('hash-loading');
    expect(d.reply).not.toHaveBeenCalled();
  });
  it.each(['my', 'review', 'today', 'due', 'overdue'])('routes /livo %s to a private list', async kind => {
    const { d, flush, lastView } = setup();
    await handleInteraction({ ...base, command: '/livo', text: kind }, 'list', d); await flush();
    expect(d.workspace!.list).toHaveBeenCalledWith(actor, { kind, page: 0 });
    expect(lastView().callback_id).toBe('livo_task_list'); expect(d.reply).not.toHaveBeenCalled();
  });
  it('opens a notification card by key and leaves its channel content private', async () => {
    const { d, flush, lastView } = setup();
    const notification = notificationMessage({ kind: 'created', taskKey: task.task_key, taskTitle: task.title }, 'https://example.com');
    const control = notification.blocks[1].elements.find((item: any) => item.action_id === 'livo_task_open');
    await handleInteraction({ ...base, type: 'block_actions', channel: { id: source.channel }, message: { ts: source.thread }, actions: [control] }, 'open', d);
    await flush();
    expect(d.workspace!.detail).toHaveBeenCalledWith(actor, 'ABC-123', true);
    expect(lastView().callback_id).toBe('livo_task_detail'); expect(d.reply).not.toHaveBeenCalled();
  });
  it('resolves the thread shortcut through the stored mapping and falls back to search if unmapped', async () => {
    const { d, flush, lastView } = setup();
    const payload = { ...base, type: 'message_action', callback_id: 'livo_open_task', channel: { id: source.channel },
      message: { ts: '123.002', thread_ts: source.thread, text: 'Untrusted ABC-999' } };
    await handleInteraction(payload, 'shortcut', d); await flush();
    expect(d.mapped).toHaveBeenCalledWith(actor, source.channel, source.thread);
    expect(d.workspace!.detail).toHaveBeenCalledWith(actor, task.id, false);
    vi.mocked(d.mapped).mockResolvedValue(undefined);
    await handleInteraction(payload, 'unmapped', d); await flush(); expect(lastView().callback_id).toBe('livo_search_tasks');
  });
  it('validates search submissions inline and keeps search results in the modal', async () => {
    const { d, flush, lastView } = setup();
    const p = { ...base, type: 'view_submission', view: { id: 'VEXAMPLE', callback_id: 'livo_search_tasks', private_metadata: JSON.stringify(source),
      state: { values: { query: { query: { value: '()%' } } } } } };
    expect((await handleInteraction(p, 'empty', d)).response_action).toBe('errors');
    expect(d.actor).not.toHaveBeenCalled();
    p.view.state.values.query.query.value = 'API';
    expect((await handleInteraction(p, 'search', d)).response_action).toBe('update'); await flush();
    expect(d.workspace!.list).toHaveBeenCalledWith(actor, { kind: 'search', text: 'API', page: 0 });
    expect(lastView().callback_id).toBe('livo_task_list'); expect(d.reply).not.toHaveBeenCalled();
  });
  it('updates from a member session, deduplicates per submission hash, and uses the durable SQL notification path', async () => {
    const { d, flush, lastView } = setup();
    expect((await handleInteraction(submission(), 'update', d)).response_action).toBe('update'); await flush();
    expect(d.workspace!.update).toHaveBeenCalledWith(actor, expect.objectContaining({ task_id: task.id, changes: { priority: 'high' },
      expected: { status_id: 'todo', assignee_id: actor.id, reviewer_id: null, due_date: null, priority: 'medium' } }),
      'TEXAMPLE:VEXAMPLE:hash-first', expect.objectContaining(source));
    expect(d.deliver).not.toHaveBeenCalled(); expect(d.commit).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith(expect.objectContaining({ user_id: actor.slack_user, channel_id: source.channel }),
      expect.stringContaining('已更新卡片：\n<https://example.com/?task=ABC-123|ABC-123 - Example card>'));
    expect(lastView().callback_id).toBe('livo_task_detail');
    const second = submission(); second.view.hash = 'hash-second';
    await handleInteraction(second, 'update2', d); await flush();
    expect(vi.mocked(d.workspace!.update).mock.calls.at(-1)?.[2]).toBe('TEXAMPLE:VEXAMPLE:hash-second');
  });
  it('shows recoverable stale form errors and never reports a failed commit as saved', async () => {
    const { d, flush, lastView } = setup();
    vi.mocked(d.workspace!.update).mockRejectedValue(Object.assign(new Error('卡片已被其他人修改'), { name: 'ActionError' }));
    await handleInteraction(submission(), 'stale', d); await flush();
    expect(JSON.stringify(lastView())).toContain('卡片已被其他人修改');
    expect(JSON.stringify(lastView())).toContain('重新開啟卡片'); expect(d.deliver).not.toHaveBeenCalled();
    expect(d.reply).toHaveBeenCalledWith(expect.anything(), '卡片已被其他人修改');
  });
  it('reports committed updates accurately even when subsequent Slack replies or detail reads fail', async () => {
    const { d, flush, lastView } = setup();
    vi.mocked(d.reply).mockRejectedValue(new Error('Slack unavailable'));
    vi.mocked(d.workspace!.detail).mockRejectedValue(new Error('Read unavailable'));
    await handleInteraction(submission(), 'saved', d); await flush();
    expect(JSON.stringify(lastView())).toContain('變更已儲存');
    expect(JSON.stringify(lastView())).not.toContain('操作未完成');
  });
  it('keeps fresh form comments eligible for channel notifications, unlike imported Slack messages', async () => {
    const { d, flush, lastView } = setup();
    await handleInteraction({ ...base, type: 'block_actions', view: { id: 'VEXAMPLE', private_metadata: JSON.stringify(source) },
      actions: [{ action_id: 'livo_task_comment', value: JSON.stringify({ taskId: task.id }) }] }, 'comment-open', d); await flush();
    const view = lastView(); expect(view.callback_id).toBe('livo_comment_task');
    expect(JSON.parse(view.private_metadata).echoExistingMessage).toBe(false);
    view.id = 'VEXAMPLE'; view.hash = 'comment-hash'; view.state = { values: {
      task: { task: { selected_option: { value: task.id } } }, comment: { comment: { value: 'New feedback' } },
    } };
    await handleInteraction({ ...base, type: 'view_submission', view }, 'comment-save', d); await flush();
    expect(d.commit).toHaveBeenCalledWith(actor, 'comment', expect.anything(), 'TEXAMPLE:VEXAMPLE:comment-hash',
      expect.objectContaining({ echoExistingMessage: false }));
    expect(sourceOf({ type: 'message_action', callback_id: 'livo_comment_task', channel: { id: source.channel } }).echoExistingMessage).toBe(true);
    expect(sourceOf({ command: '/livo', channel_id: source.channel }).echoExistingMessage).toBe(false);
  });
  it('omits source-channel suppression from fresh comment JWTs but retains it for actual Slack message imports', async () => {
    const claims = async (echoExistingMessage: boolean) => JSON.parse(atob((await memberJwt('example-secret',
      { auth_id: '00000000-0000-4000-8000-000000000001' }, { id: 'binding', platform_team_id: source.team, platform_user_id: source.user }, { ...source, echoExistingMessage })).split('.')[1]));
    expect((await claims(false)).livo_slack_source.channel).toBe('');
    expect((await claims(true)).livo_slack_source.channel).toBe(source.channel);
  });
  it('enforces the feature switch for notification actions and mutation submissions', async () => {
    const { d, flush } = setup(); vi.mocked(d.enabled).mockResolvedValue(false);
    await handleInteraction(submission(), 'off', d);
    await handleInteraction({ ...base, type: 'block_actions', actions: [{ action_id: 'livo_task_open', value: JSON.stringify({ taskId: task.id }) }] }, 'off2', d);
    await flush(); expect(d.actor).not.toHaveBeenCalled(); expect(d.workspace!.update).not.toHaveBeenCalled();
  });
  it('returns a progress ACK before a slow feature check without bypassing a disabled feature', async () => {
    const { d, flush, lastView } = setup(); let finish!: (enabled: boolean) => void;
    vi.mocked(d.enabled).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    expect((await handleInteraction(submission(), 'slow-feature', d)).response_action).toBe('update');
    expect(d.actor).not.toHaveBeenCalled(); finish(false); await flush();
    expect(d.workspace!.update).not.toHaveBeenCalled(); expect(JSON.stringify(lastView())).toContain('未啟用');
  });
  it('clears a prior card thread when creating from the workspace and keeps the receipt private', async () => {
    const { d, flush, lastView } = setup();
    await handleInteraction({ ...base, type: 'block_actions', view: { id: 'VEXAMPLE', private_metadata: JSON.stringify(source) },
      actions: [{ action_id: 'livo_workspace_new', value: '{}' }] }, 'new', d); await flush();
    const view = lastView(); expect(view.callback_id).toBe('livo_create_task');
    expect(JSON.parse(view.private_metadata).thread).toBe('');
    view.id = 'VEXAMPLE'; view.hash = 'new-hash'; view.state = { values: {
      title: { title: { value: 'New card' } }, project: { project: { selected_option: { value: 'project' } } },
      assignee: { assignee: { selected_option: { value: actor.id } } },
      status: { status: { selected_option: { value: 'todo' } } }, priority: { priority: { selected_option: { value: 'medium' } } },
    } };
    await handleInteraction({ ...base, type: 'view_submission', view }, 'new-submit', d); await flush();
    expect(d.commit).toHaveBeenCalledWith(actor, 'create', expect.anything(), 'TEXAMPLE:VEXAMPLE:new-hash', expect.objectContaining({ thread: '' }));
    expect(d.reply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已建立卡片'), false);
    expect(lastView().callback_id).toBe('livo_task_detail');
  });
  it('keeps a successfully saved comment successful when its receipt fails', async () => {
    const { d, flush, lastView } = setup(); vi.mocked(d.reply).mockRejectedValue(new Error('Slack reply failed'));
    await handleInteraction({ ...base, type: 'view_submission', view: { id: 'VEXAMPLE', hash: 'comment-hash',
      callback_id: 'livo_comment_task', private_metadata: JSON.stringify({ ...source, echoExistingMessage: false }),
      state: { values: { task: { task: { selected_option: { value: task.id } } }, comment: { comment: { value: 'Feedback' } } } } } }, 'comment', d);
    await flush(); expect(d.commit).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(lastView())).toContain('留言已儲存'); expect(JSON.stringify(lastView())).not.toContain('操作未完成');
  });
  it('replaces the panel loading view when Slack rejects the create form, keeping the hash guard', async () => {
    const { d, flush, lastView } = setup(); vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(d.slack).mockImplementation(async (method, body) => {
      if (method === 'views.update' && body.view.callback_id === 'livo_create_task')
        throw Object.assign(new Error('Slack operation failed'), { slackError: 'invalid_arguments' });
      return { view: { id: 'VEXAMPLE', hash: 'hash-loading' } };
    });
    await handleInteraction({ ...base, type: 'block_actions', view: { id: 'VEXAMPLE', hash: 'hash-home', private_metadata: JSON.stringify(source) },
      actions: [{ action_id: 'livo_workspace_new', value: '{}' }] }, 'new-rejected', d); await flush();
    const updates = vi.mocked(d.slack).mock.calls.filter(([method]) => method === 'views.update').map(([, body]) => body);
    expect(updates.map(body => [body.view.callback_id, body.hash])).toEqual([
      ['livo_result', 'hash-home'], ['livo_create_task', 'hash-loading'], ['livo_result', 'hash-loading']]);
    expect(JSON.stringify(lastView())).toContain('LIVO 暫時無法回應'); expect(d.reply).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it('still tells the person to reopen /livo when the panel was closed while loading', async () => {
    const { d, flush } = setup();
    vi.mocked(d.slack).mockImplementation(async method => {
      if (method === 'views.update') throw Object.assign(new Error('Slack operation failed'), { slackError: 'not_found' });
      return { view: { id: 'VEXAMPLE', hash: 'hash-loading' } };
    });
    await handleInteraction({ ...base, command: '/livo', text: '' }, 'closed', d); await flush();
    expect(vi.mocked(d.slack).mock.calls.filter(([method]) => method === 'views.update')).toHaveLength(1);
    expect(d.reply).toHaveBeenCalledWith(expect.anything(), '任務視窗已關閉或更新失敗，請重新執行 /livo。');
  });
  it('does not send a false failure after a direct comment commits but its private receipt fails', async () => {
    const { d } = setup(); vi.mocked(d.reply).mockRejectedValue(new Error('Slack reply failed'));
    await handleInteraction({ ...base, command: '/livo', text: 'comment ABC-123 Feedback' }, 'direct-comment', d);
    expect(d.commit).toHaveBeenCalledTimes(1); expect(d.reply).toHaveBeenCalledTimes(1);
    expect(vi.mocked(d.reply).mock.calls[0][1]).toContain('已新增留言');
  });
});
