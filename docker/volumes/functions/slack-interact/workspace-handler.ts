import { commentModal, createModal, DISABLED, loadFailure, loadFailureLog, messageModal, replaceLoadingView, taskReceipt, UNAVAILABLE,
  UNRESPONSIVE, withinBudget, type Row } from './core.ts';
import type { Actions } from './handler.ts';
import { detailModal, editModal, homeModal, listModal, parseEditSubmission, parseWorkspaceCommand, searchModal, type TaskQuery } from './workspace-ui.ts';
import { workspaceText } from './workspace-i18n.ts';

const safeError = (error: unknown, locale?: string) => workspaceText(error instanceof Error && error.name === 'ActionError'
  ? error.message : '操作未完成，請重新開啟再試一次；若持續失敗，請洽管理員。', locale);
const fail = (message: string): never => { throw Object.assign(new Error(message), { name: 'ActionError' }); };
const buttonIds = new Set(['livo_workspace_home', 'livo_workspace_query', 'livo_workspace_new', 'livo_workspace_search',
  'livo_tasks_page', 'livo_task_open', 'livo_task_edit', 'livo_task_comment', 'livo_comments_page']);
function valueOf(action?: Row): Row {
  try { const value = JSON.parse(action?.value || '{}'); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}
function notice(text: string, source: Row, taskId?: string): Row {
  const view = homeModal(source);
  view.blocks.unshift({ type: 'section', text: { type: 'plain_text', text: workspaceText(text, source.locale).slice(0, 2500) } });
  if (taskId) view.blocks.splice(1, 0, { type: 'actions', elements: [{ type: 'button', action_id: 'livo_task_open',
    text: { type: 'plain_text', text: workspaceText('重新開啟卡片', source.locale) }, value: JSON.stringify({ taskId }) }] });
  return view;
}
const receiptPayload = (p: Row, source: Row): Row => ({ ...p, channel_id: source.channel, user_id: p.user?.id || p.user_id });

/** Modal reads stay private; background work never blocks the Socket Mode ACK. */
export async function handleWorkspaceInteraction(p: Row, d: Actions, source: Row): Promise<Row | undefined> {
  if (!d.workspace) return undefined;
  const workspace = d.workspace, command = p.command ? parseWorkspaceCommand(String(p.text || '')) : undefined;
  const action = p.type === 'block_actions' ? p.actions?.[0] : undefined;
  const callback = p.view?.callback_id;
  const submission = p.type === 'view_submission' && ['livo_search_tasks', 'livo_edit_task'].includes(callback);
  const shortcut = p.type === 'message_action' && p.callback_id === 'livo_open_task';
  if (!command && !buttonIds.has(action?.action_id) && !submission && !shortcut) return undefined;

  if (submission) {
    const parsed = callback === 'livo_edit_task' ? parseEditSubmission(p.view) : undefined;
    if (parsed && Object.keys(parsed.errors).length) return { response_action: 'errors', errors: parsed.errors };
    const search = String(p.view.state?.values?.query?.query?.value || '').trim().slice(0, 100);
    if (!parsed && !search.replace(/[^\p{L}\p{N} _-]/gu, '').trim())
      return { response_action: 'errors', errors: { query: workspaceText('請輸入卡號或標題關鍵字。', source.locale) } };
    d.background((async () => {
      let view: Row, plain = UNRESPONSIVE;
      try {
        if (!(await d.enabled())) fail(DISABLED);
        const actor = await d.actor(p); source.locale = actor.locale;
        if (!parsed) {
          const query: TaskQuery = { kind: 'search', text: search, page: 0 };
          view = listModal(query, await workspace.list(actor, query), source);
        } else {
          // A modal can be reused for several edits. Its hash changes between
          // forms, while Slack retries of one submission retain the same hash.
          const result = await workspace.update(actor, parsed.fields, `${actor.team}:${p.view.id}:${p.view.hash || 'submission'}`, source);
          const text = taskReceipt('comment', result.task, d.link(result.task)).replace('已新增留言',
            workspaceText(result.unchanged ? '卡片內容未變更' : '已更新卡片', source.locale));
          // Once committed, a Slack receipt or follow-up read failure must not
          // tell the user that saving failed and invite a duplicate mutation.
          await d.reply(receiptPayload(p, source), text).catch(() => {});
          plain = '變更已儲存。重新開啟卡片可查看最新內容。';
          try {
            const task = await workspace.detail(actor, result.task.id);
            view = detailModal(task, d.link(task), source, await workspace.comments(actor, task.id, 0));
            view.blocks.unshift({ type: 'context', elements: [{ type: 'plain_text',
              text: workspaceText(result.unchanged ? '內容相同，未重複修改。' : '變更已儲存。', source.locale) }] });
          } catch { view = notice('變更已儲存。重新開啟卡片可查看最新內容。', source, result.task.id); }
        }
      } catch (error) {
        plain = safeError(error, source.locale);
        view = notice(plain, source, parsed?.fields.task_id);
        if (parsed) await d.reply(receiptPayload(p, source), plain).catch(() => {});
      }
      // A rejected result view falls back to the same outcome as plain text.
      const outcome = await replaceLoadingView(d.slack, p.view.id, view, messageModal(workspaceText(plain, source.locale)));
      if (!parsed && (outcome === 'left' || outcome === 'failed'))
        await d.reply(receiptPayload(p, source), workspaceText('搜尋視窗已關閉或更新失敗，請重新執行 /livo search。', source.locale)).catch(() => {});
    })());
    return { response_action: 'update', view: messageModal(workspaceText(parsed ? '正在儲存變更…' : '正在搜尋 LIVO…', source.locale)) };
  }

  // Consume trigger/hash before potentially slow account and database lookups.
  const opening = p.view?.id
    ? await d.slack('views.update', { view_id: p.view.id, ...(p.view.hash ? { hash: p.view.hash } : {}), view: messageModal(workspaceText('正在載入 LIVO…', source.locale)) })
    : await d.slack('views.open', { trigger_id: p.trigger_id, view: messageModal(workspaceText('正在載入 LIVO…', source.locale)) });
  d.background((async () => {
    let view: Row;
    try {
      view = await withinBudget((async (): Promise<Row> => {
        if (!(await d.enabled())) fail(DISABLED);
        const actor = await d.actor(p); source.locale = actor.locale;
        const actionId = action?.action_id, value = valueOf(action);
        if (command?.kind === 'home' || actionId === 'livo_workspace_home') return homeModal(source, await d.flags?.().catch(() => ({ approvals: false })) ?? { approvals: false });
        if (command?.kind === 'search' || actionId === 'livo_workspace_search') return searchModal(source);
        if (command?.kind === 'query' || ['livo_workspace_query', 'livo_tasks_page'].includes(actionId)) {
          const query = (command?.kind === 'query' ? command.query : value) as TaskQuery;
          return listModal(query, await workspace.list(actor, query), source);
        }
        if (actionId === 'livo_workspace_new') return createModal(await d.catalog(actor), actor, {},
          { ...source, thread: '', echoExistingMessage: false });
        const key = command && 'key' in command ? command.key : value.key;
        const mapped = shortcut ? await d.mapped(actor, source.channel, source.thread) : undefined;
        if (shortcut && !mapped) return searchModal(source);
        const id = mapped?.id || value.taskId || key;
        if (!id) fail(UNAVAILABLE);
        const task = await workspace.detail(actor, String(id), !!key && !value.taskId && !mapped);
        if (command?.kind === 'edit' || actionId === 'livo_task_edit') return editModal(task, source);
        if (actionId === 'livo_task_comment') return commentModal(task, '', { ...source, echoExistingMessage: false });
        return detailModal(task, d.link(task), source, await workspace.comments(actor, task.id, value.page || 0));
      })());
    } catch (error) {
      if (loadFailureLog(error)) console.error(loadFailureLog(error));
      view = notice(loadFailure(error), source);
    }
    // Never leave the loading text up: a rejected view falls back to a plain message.
    const outcome = await replaceLoadingView(d.slack, opening.view?.id || p.view?.id, view,
      messageModal(workspaceText(UNRESPONSIVE, source.locale)), opening.view?.hash);
    if (outcome === 'left' || outcome === 'failed')
      await d.reply(receiptPayload(p, source), workspaceText('任務視窗已關閉或更新失敗，請重新執行 /livo。', source.locale)).catch(() => {});
  })());
  return {};
}
