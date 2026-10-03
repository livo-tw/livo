import { handleKnowledgeWork } from './knowledge-work-handler.ts';
import type { KnowledgeWorkData } from './knowledge-work-backend.ts';
import { handleWork } from './work-handler.ts';
import { handleRelease } from './release-handler.ts';
import type { ReleaseData } from './release-backend.ts';
import type { WorkData } from './work-backend.ts';
import { handleQaSlack, isQaSlackPayload, type QaSlackActions } from '../qa/slack.ts';
import { commentModal, createModal, DISABLED, localize, messageDraft, messageModal, parseCommand, parseSubmission, taskReceipt, UNAVAILABLE, type Row } from './core.ts';
import { handleApprovalInteraction } from './approval-handler.ts';
import type { ApprovalData } from './approval-backend.ts';
import { handleWorkspaceInteraction } from './workspace-handler.ts';
import type { WorkspaceData } from './workspace-backend.ts';
import { detailModal } from './workspace-ui.ts';
import { workspaceText } from './workspace-i18n.ts';
import { handleKnowledgeInteraction, type KnowledgeData } from './knowledge-workspace.ts';
import { handleTaskContextInteraction, type TaskContextData } from './task-context.ts';
import { handlePlanning } from './planning-handler.ts';
import type { PlanningData } from './planning-backend.ts';

import { handleKnowledgeSlack, type KnowledgeSlackActions } from './knowledge.ts';

export interface Actions {
  knowledgeWork?: KnowledgeWorkData;
  releases?: ReleaseData;
  work?: WorkData;
  knowledgeSearch?: KnowledgeSlackActions;
  qa?: QaSlackActions;
  workspace?: WorkspaceData;
  knowledge?: KnowledgeData;
  taskContext?: TaskContextData;
  approvals?: ApprovalData;
  planning?: PlanningData;
  enabled(): Promise<boolean>;
  heartbeat(connected: boolean): Promise<void>;
  actor(payload: Row): Promise<Row>;
  catalog(actor: Row): Promise<Row>;
  search(actor: Row, field: string, text: string): Promise<Row[]>;
  task(actor: Row, id: string, byKey?: boolean): Promise<Row | undefined>;
  mapped(actor: Row, channel: string, ts: string): Promise<Row | undefined>;
  slack(method: string, body: Row): Promise<Row>;
  reply(payload: Row, text: string, thread?: boolean): Promise<void>;
  commit(actor: Row, kind: string, fields: Row, requestId: string, source: Row): Promise<Row>;
  deliver(actor: Row, result: Row, source: Row): Promise<void>;
  background(work: Promise<unknown>): void;
  link(task: Row): string;
}
export const sourceOf = (p: Row): Row => p.view ? JSON.parse(p.view.private_metadata || '{}') : ({
  channel: p.channel_id || p.channel?.id || '',
  thread: p.message?.thread_ts || p.message?.ts || '',
  user: p.user_id || p.user?.id || '', team: p.team_id || p.team?.id || '',
  echoExistingMessage: p.type === 'message_action' && p.callback_id === 'livo_comment_task',
});
const HELP = '/livo docs 關鍵字：搜尋知識／任務／QA／檔案\n/livo specs 關鍵字：有效規格與決策\n/livo drafts：我的私人草稿\n/livo meeting、weekly：會議／週報預覽後確認儲存\n/livo work ABC-123：子任務、清單、依賴與接手確認\n/livo approvals：私人簽核清單與同意／拒絕／退回／撤回\n/livo bug new 標題：建立 QA Bug\n/livo bug link BUG_ID：綁定 Bug 討論串\n/livo bug fix / deploy / pass / fail / close / reopen BUG_ID：開啟操作表單\n/livo：開啟任務面板\n/livo my、review：我的任務／待我驗收\n/livo today、due、overdue：今天／未來 7 天到期／逾期\n/livo reminders：我的暫停提醒\n/livo pause ABC-123：暫停自己的到期提醒\n/livo deadline ABC-123：修改期限與改期原因\n/livo search 關鍵字：搜尋卡片\n/livo ABC-123 或 /livo edit ABC-123：查看／修改卡片\n/livo new 標題：建立卡片\n/livo comment ABC-123 留言：新增留言（省略文字可開表單）\n訊息選單：建立 LIVO 卡片／留言到 LIVO 卡片／開啟 LIVO 卡片';
const safeError = (error: unknown) => error instanceof Error && error.name === 'ActionError'
  ? error.message : '操作未完成，請重新開啟表單再試一次；若持續失敗，請洽管理員';

/** The transport never interprets commands. All ACK response payloads originate here. */
export async function handleInteraction(p: Row, envelopeId: string, d: Actions): Promise<Row> {
  if (d.qa && isQaSlackPayload(p)) return handleQaSlack(p, envelopeId, d.qa);
  if (d.knowledgeSearch) {
    const knowledge = await handleKnowledgeSlack(p, d.knowledgeSearch);
    if (knowledge !== undefined) return knowledge;
  }
  try {
    const releaseResponse = await handleRelease(p, d, sourceOf(p));
    if (releaseResponse !== undefined) return releaseResponse;
    const approvalResponse = await handleApprovalInteraction(p, d, sourceOf(p));
    if (approvalResponse !== undefined) return approvalResponse;
    const contextResponse = await handleTaskContextInteraction(p, d, sourceOf(p));
    if (contextResponse !== undefined) return contextResponse;
    const knowledgeWorkResponse=await handleKnowledgeWork(p,d,sourceOf(p));
    if(knowledgeWorkResponse!==undefined)return knowledgeWorkResponse;
    const knowledgeResponse = await handleKnowledgeInteraction(p, d, sourceOf(p));
    if (knowledgeResponse !== undefined) return knowledgeResponse;
    const planningResponse=await handlePlanning(p,d,sourceOf(p));
    if(planningResponse!==undefined)return planningResponse;
    const workResponse=await handleWork(p,d,sourceOf(p));
    if(workResponse!==undefined)return workResponse;
    const workspaceResponse = await handleWorkspaceInteraction(p, d, sourceOf(p));
    if (workspaceResponse !== undefined) return workspaceResponse;
    const deferredSubmission = p.type === 'view_submission' && ['livo_create_task', 'livo_comment_task'].includes(p.view?.callback_id);
    if (!deferredSubmission && !(await d.enabled())) {
      if (p.type === 'heartbeat') return { disabled: true };
      if (p.type === 'block_suggestion') return { options: [] };
      if (p.type === 'view_submission') return { response_action: 'update', view: messageModal(DISABLED) };
      await d.reply(p, DISABLED); return {};
    }
    if (p.type === 'heartbeat') { await d.heartbeat(p.connected === true); return {}; }
    if (p.type === 'view_closed') return {};
    if (p.type === 'view_submission') {
      if (!['livo_create_task', 'livo_comment_task'].includes(p.view?.callback_id)) return {};
      const parsed = parseSubmission(p.view);
      if (Object.keys(parsed.errors).length) return { response_action: 'errors', errors: Object.fromEntries(
        Object.entries(parsed.errors).map(([field, text]) => [field, localize(text, sourceOf(p).locale)])) };
      const source = sourceOf(p);
      // Return a progress view within the ACK budget; the durable database transaction
      // and notifications run under EdgeRuntime.waitUntil and report via DM as well.
      d.background((async () => {
        let text: string;
        let successful = false;
        let completedView: Row | undefined;
        try {
          if (!(await d.enabled())) throw Object.assign(new Error(DISABLED), { name: 'ActionError' });
          const actor = await d.actor(p);
          const result = await d.commit(actor, parsed.kind, parsed.fields, `${actor.team}:${p.view.id}${p.view.hash ? `:${p.view.hash}` : ''}`, source);
          if (!result.duplicate) await d.deliver(actor, result, source).catch(() => {});
          text = taskReceipt(parsed.kind, result.task, d.link(result.task));
          successful = true;
          await d.reply({ ...p, ...source, user_id: p.user.id, channel_id: source.channel }, text, parsed.kind === 'create' && !!source.thread).catch(() => {});
          if (d.workspace) {
            try {
              const task = await d.workspace.detail(actor, result.task.id);
              completedView = detailModal(task, d.link(task), source, await d.workspace.comments(actor, task.id, 0));
              completedView.blocks.unshift({ type: 'context', elements: [{ type: 'plain_text',
                text: workspaceText(parsed.kind === 'create' ? '卡片已建立。' : '留言已儲存。', source.locale) }] });
            } catch { /* Keep the successful receipt if a follow-up read fails. */ }
          }
        } catch (error) {
          text = safeError(error);
          await d.reply({ ...p, user_id: p.user.id, channel_id: source.channel }, text).catch(() => {});
        }
        await d.slack('views.update', { view_id: p.view.id, view: completedView || messageModal(text, successful) }).catch(() => {});
      })());
      return { response_action: 'update', view: messageModal('正在儲存，完成後會收到 LIVO 通知。') };
    }
    if (p.type === 'block_suggestion') {
      const actor = await d.actor(p);
      const results = await d.search(actor, p.action_id, String(p.value || ''));
      return p.action_id === 'project' && results.length ? { option_groups: results } : { options: results };
    }
    const command = p.command ? parseCommand(String(p.text || '')) : undefined;
    if (command?.kind === 'help') { await d.reply(p, HELP); return {}; }
    if (command?.kind === 'comment' && !command.key) { await d.reply(p, HELP); return {}; }
    if (!p.command && !['livo_create_task', 'livo_comment_task'].includes(p.callback_id)) return {};
    if (command?.kind === 'comment' && command.text) {
      const actor = await d.actor(p), task = await d.task(actor, command.key, true);
      if (!task) { await d.reply(p, UNAVAILABLE); return {}; }
      if (command.text.length > 3000) { await d.reply(p, '留言最多 3000 字'); return {}; }
      const result = await d.commit(actor, 'comment', { task_id: task.id, text: command.text }, `${actor.team}:${envelopeId}`, sourceOf(p));
      if (!result.duplicate) await d.deliver(actor, result, sourceOf(p)).catch(() => {});
      await d.reply(p, taskReceipt('comment', result.task, d.link(result.task))).catch(() => {}); return {};
    }
    // Consume the short-lived trigger first, before email lookup or catalog reads.
    const opening = await d.slack('views.open', { trigger_id: p.trigger_id, view: messageModal('正在載入 LIVO…') });
    let view: Row;
    try {
      const actor = await d.actor(p), source = sourceOf(p);
      source.locale = actor.locale;
      let draft: Row = {};
      if (p.message) {
        const permalink = await d.slack('chat.getPermalink', { channel: source.channel, message_ts: p.message.ts });
        draft = messageDraft(p.message, permalink.permalink);
      }
      if (command?.kind === 'comment' || p.callback_id === 'livo_comment_task') {
        const task = command?.kind === 'comment' ? await d.task(actor, command.key, true)
          : await d.mapped(actor, source.channel, source.thread);
        if (command && !task) throw Object.assign(new Error(UNAVAILABLE), { name: 'ActionError' });
        view = commentModal(task, draft.description || '', source);
      } else {
        const catalog = await d.catalog(actor);
        view = createModal(catalog, actor, { ...draft, ...(command?.kind === 'new' ? { title: command.text } : {}) }, source);
      }
    } catch (error) { view = messageModal(safeError(error)); }
    await d.slack('views.update', { view_id: opening.view.id, view });
    return {};
  } catch (error) {
    if (p.type === 'block_suggestion') return { options: [] };
    await d.reply(p, safeError(error)).catch(() => {});
    return {};
  }
}
