import type { Row } from './core.ts';
import type { ApprovalEntry, ApprovalPage, ApprovalSubmitCommand, ApprovalSubmitPreparation, ApprovalSubmitTarget } from './approval-backend.ts';
import { ApprovalCommandError, parseApprovalCommand, type ApprovalExpectedTask } from '../approval-command/core.ts';
export type ApprovalControl = { requestId: string; version: number; step: number; operation: 'open' | 'approve' | 'reject' | 'return' | 'withdraw' };
export type ApprovalSubmitDraft = {taskId:string;expected:ApprovalExpectedTask;targets:Array<{id:string;ruleId:string|null}>;cursor:number;commandId:string};
export const APPROVAL_TEXT: Record<string, [string, string, string]> = {
  title: ['LIVO 簽核', 'LIVO 签核', 'LIVO approvals'], close: ['關閉', '关闭', 'Close'],
  private: ['只有你看得到；每次操作都重新確認權限。', '只有你看得到；每次操作都重新确认权限。', 'Only visible to you. Permissions are checked for every action.'],
  empty: ['這一頁沒有待你處理的簽核。', '这一页没有待你处理的签核。', 'No approvals for you on this page.'],
  next: ['下一頁', '下一页', 'Next page'], list: ['回到簽核清單', '回到签核清单', 'Approval list'],
  home: ['任務面板', '任务面板', 'Task workspace'], open: ['查看簽核', '查看签核', 'View approval'],
  approve: ['同意', '同意', 'Approve'], reject: ['拒絕', '拒绝', 'Reject'], return: ['退回', '退回', 'Return'], withdraw: ['撤回', '撤回', 'Withdraw'],
  confirm: ['確認送出', '确认提交', 'Confirm'], comment: ['留言（選填）', '留言（选填）', 'Comment (optional)'],
  step: ['步驟', '步骤', 'Step'], version: ['版本', '版本', 'Version'],
  transition: ['狀態變更', '状态变更', 'Status change'], requester: ['申請人', '申请人', 'Requester'], unknown: ['無法取得', '无法获取', 'Unavailable'],
  pending: ['待簽核', '待签核', 'Pending'], approved: ['已同意', '已同意', 'Approved'], rejected: ['已拒絕', '已拒绝', 'Rejected'], returned: ['已退回', '已退回', 'Returned'], cancelled: ['已撤回', '已撤回', 'Withdrawn'],
  legacy: ['這是尚未保存規則快照的舊簽核，請由申請人或管理員撤回，再重新送簽。', '这是尚未保存规则快照的旧签核，请由申请人或管理员撤回，再重新提交。', 'This legacy request has no saved rule snapshot. The requester or an administrator must withdraw it and submit it again.'],
  disabled: ['簽核功能已停用；仍可撤回既有申請。', '签核功能已停用；仍可撤回已有申请。', 'Approvals are disabled. Existing requests can still be withdrawn.'],
  loading: ['正在載入簽核…', '正在加载签核…', 'Loading approvals…'], saving: ['正在送出簽核操作…', '正在提交签核操作…', 'Saving approval action…'],
  success: ['簽核操作已儲存。', '签核操作已保存。', 'Approval action saved.'],
  stale: ['這個簽核版本或步驟已變更。請重新開啟清單，確認最新內容後再操作。', '这个签核版本或步骤已变更。请重新打开列表，确认最新内容后再操作。', 'This request version or step has changed. Reopen the list and review the current details before acting.'],
  oldButton: ['這是舊版簽核按鈕，請從目前的清單重新選擇。', '这是旧版签核按钮，请从当前列表重新选择。', 'This is an older approval button. Select the request from the current list.'],
  unavailable: ['簽核不存在、無法存取，或你已無權執行這項操作。', '签核不存在、无法访问，或你已无权执行此操作。', 'The request is unavailable or you no longer have permission for this action.'],
  invalid: ['表單資料不完整，請重新開啟簽核。', '表单信息不完整，请重新打开签核。', 'This form is incomplete. Reopen the approval.'],
  tooLong: ['留言最多 3000 字。', '留言最多 3000 字。', 'Comments are limited to 3000 characters.'],
  uncertain: ['尚未確認儲存結果。可保持相同留言再試一次，或到 LIVO 查看；請勿另開相同操作。', '尚未确认保存结果。可保持相同留言再试一次，或到 LIVO 查看；请勿另开相同操作。', 'The save result is not yet confirmed. Retry with the same comment, or check LIVO. Do not start another copy of this action.'],
  prerequisite: ['尚未完成狀態的前置步驟，請到 LIVO 確認。', '尚未完成状态的前置步骤，请到 LIVO 确认。', 'Required workflow steps are incomplete. Check LIVO before continuing.'],
  reopen: ['簽核視窗已關閉或更新失敗，請重新執行 /livo approvals。', '签核窗口已关闭或更新失败，请重新执行 /livo approvals。', 'The approval window was closed or could not be updated. Run /livo approvals again.'],
  web: ['在 LIVO 開啟卡片', '在 LIVO 打开卡片', 'Open task in LIVO'],
  submit: ['送簽', '送签', 'Request approval'], target: ['選擇簽核通過後的狀態', '选择签核通过后的状态', 'Status after approval'],
  continue: ['下一步', '下一步', 'Continue'], previous: ['上一頁', '上一页', 'Previous page'],
  submitIntro: ['先選擇目標狀態，再確認送簽；此步驟不會修改卡片。', '先选择目标状态，再确认送签；此步骤不会修改卡片。', 'Choose a target status, then confirm. This step does not change the task.'],
  submitEffect: ['送簽後先進入待簽核，原狀態保留；簽核通過後才變更狀態。', '送签后先进入待签核，原状态保留；签核通过后才变更状态。', 'Submitting creates a pending approval. The task status changes only after approval.'],
  noTargets: ['此頁沒有可送簽的目標狀態。', '此页没有可送签的目标状态。', 'No eligible target statuses on this page.'],
  omittedTargets: ['部分狀態的簽核規則不完整，暫時無法選擇；請在 LIVO 檢查規則。', '部分状态的签核规则不完整，暂时无法选择；请在 LIVO 检查规则。', 'Some statuses have incomplete approval rules. Check those rules in LIVO.'],
  ruleMatched: ['使用這次狀態變更所設定的簽核規則。', '使用此次状态变更所设定的签核规则。', 'Use the approval rule configured for this status transition.'],
  fallbackRule: ['未設定匹配規則，依系統流程交由管理員簽核。', '未设定匹配规则，按系统流程交由管理员签核。', 'No matching rule is configured. The system uses administrator approval.'],
  requirement: ['此卡片的後續狀態變更', '此卡片的后续状态变更', 'Future status changes for this task'],
  enableRequirement: ['啟用「需要簽核」；此後每次狀態變更都須送簽。', '启用“需要签核”；此后每次状态变更都须送签。', 'Enable required approval for every future status change.'],
  requirementNeeded: ['此卡片尚未要求簽核，且沒有匹配規則；請明確勾選啟用後再送簽。', '此卡片尚未要求签核，且没有匹配规则；请明确勾选启用后再送签。', 'This task has no approval requirement or matching rule. Explicitly enable required approval to submit.'],
  submitStale: ['卡片或匹配規則已變更。請重新開啟送簽，確認最新內容。', '卡片或匹配规则已变更。请重新打开送签，确认最新内容。', 'The task or matching rule changed. Reopen the request and review the current details.'],
  submitRetry: ['尚未確認送簽結果。再次確認會重試同一筆送簽，保留原選擇；不會另建一筆操作。', '尚未确认送签结果。再次确认会重试同一笔送签，保留原选择；不会另建一笔操作。', 'The submission result is unconfirmed. Confirm again to retry the same request with the original choices.'],
  submitReopen: ['送簽視窗已關閉或更新失敗，請重新執行 /livo submit 卡片編號。', '送签窗口已关闭或更新失败，请重新执行 /livo submit 卡片编号。', 'The request window was closed or could not update. Run /livo submit TASKKEY again.'],
  invalidRule: ['簽核規則重複、不完整，或指定簽核人已停用；請在 LIVO 確認規則後再送簽。', '签核规则重复、不完整，或指定签核人已停用；请在 LIVO 确认规则后再送签。', 'The approval rule is ambiguous, incomplete, or names an inactive approver. Check the rule in LIVO before submitting.'],
};
export const approvalText = (key: string, locale?: string): string => APPROVAL_TEXT[key]?.[/^en\b/i.test(locale || '') ? 2 : /^zh-(CN|SG|Hans)/i.test(locale || '') ? 1 : 0] || key;
const text = (value: unknown, max = 2900) => String(value ?? '').slice(0, max);
const plain = (value: unknown) => text(value, 30000).replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  .replace(/<\/(?:p|div|li)>|<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '')
  .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e: string) => ({amp:'&',lt:'<',gt:'>',quot:'"','#39':"'",nbsp:' '})[e] || '').trim().slice(0, 2000);
const section = (value: string): Row => ({ type: 'section', text: { type: 'plain_text', text: text(value) || '—' } });
const button = (id: string, label: string, value: Row): Row => ({ type: 'button', action_id: id, text: { type: 'plain_text', text: text(label, 75) }, value: JSON.stringify(value) });
const navigation = (source: Row): Row => ({ type: 'actions', elements: [button('livo_approvals_page', approvalText('list', source.locale), {cursor:0}), button('livo_workspace_home', approvalText('home', source.locale), {})] });
const sourceMetadata = (source: Row): Row => ({ team: text(source.team, 80), user: text(source.user, 80), channel: text(source.channel, 80), locale: text(source.locale, 20) });
const transition = (item: ApprovalEntry, source: Row) => `${approvalText('transition',source.locale)}: ${text(item.task.from_status_name || approvalText('unknown',source.locale),100)} → ${text(item.task.to_status_name || approvalText('unknown',source.locale),100)}`;
const modal = (source: Row, callback: string, blocks: Row[], extra: Row = {}): Row => ({ type: 'modal', callback_id: callback,
  title: {type:'plain_text',text:approvalText('title',source.locale)}, close: {type:'plain_text',text:approvalText('close',source.locale)},
  private_metadata: JSON.stringify(sourceMetadata(source)), blocks, ...extra });
export const approvalControl = (entry: ApprovalEntry, operation: ApprovalControl['operation']): ApprovalControl => ({ requestId: entry.request.id, version: entry.request.version, step: entry.request.current_step, operation });
export function parseApprovalControl(value: unknown): ApprovalControl | null {
  try {
    const v = typeof value === 'string' ? JSON.parse(value) : value;
    if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !['requestId','version','step','operation'].includes(k)) ||
      typeof v.requestId !== 'string' || !/^[\w-]{1,200}$/.test(v.requestId) || !Number.isSafeInteger(v.version) || v.version < 1 ||
      !Number.isSafeInteger(v.step) || v.step < 1 || !['open','approve','reject','return','withdraw'].includes(v.operation)) return null;
    return v;
  } catch { return null; }
}
export function approvalNotice(key: string, source: Row): Row {
  return modal(source, 'livo_approval_notice', [section(approvalText(key,source.locale)), navigation(source)]);
}
export function approvalListModal(page: ApprovalPage, source: Row, notice?: string): Row {
  const blocks: Row[] = [section(approvalText('private',source.locale))];
  if (notice) blocks.push(section(approvalText(notice,source.locale)));
  if (!page.enabled) blocks.push(section(approvalText('disabled',source.locale)));
  if (!page.entries.length) blocks.push(section(approvalText('empty',source.locale)));
  for (const item of page.entries) {
    blocks.push(section(`${text(item.task.task_key,80)} · ${text(item.task.title,220)}\n${text(item.task.project_name,100)} · ${approvalText('step',source.locale)} ${item.request.current_step}`),
      {type:'actions',elements:[button('livo_approval_open',approvalText('open',source.locale),approvalControl(item,'open'))]});
  }
  if (page.nextCursor !== null) blocks.push({type:'actions',elements:[button('livo_approvals_page',approvalText('next',source.locale),{cursor:page.nextCursor})]});
  blocks.push(navigation(source));
  return modal(source,'livo_approval_list',blocks);
}
export function approvalDetailModal(item: ApprovalEntry, url: string, source: Row, notice?: string): Row {
  const r = item.request, blocks = [section(`${text(item.task.task_key,80)} · ${text(item.task.title,250)}\n${text(item.task.project_name,100)}`),
    section(`${approvalText(r.status,source.locale)} · ${approvalText('step',source.locale)} ${r.current_step} · ${approvalText('version',source.locale)} ${r.version}`),
    section(transition(item,source)),section(`${approvalText('requester',source.locale)}: ${text(item.task.requester_name || approvalText('unknown',source.locale),100)}`)];
  if (notice) blocks.unshift(section(approvalText(notice,source.locale)));
  if (item.task.requirement) blocks.push(section(plain(item.task.requirement)));
  if (item.legacy) blocks.push(section(approvalText('legacy',source.locale)));
  if (!item.enabled) blocks.push(section(approvalText('disabled',source.locale)));
  const controls: Row[] = item.canAct ? (['approve','reject','return'] as const).map(op => button(`approval_${op}`,approvalText(op,source.locale),approvalControl(item,op))) : [];
  if (item.canWithdraw) controls.push(button('approval_withdraw',approvalText('withdraw',source.locale),approvalControl(item,'withdraw')));
  if (controls.length) blocks.push({type:'actions',elements:controls});
  if (/^https?:\/\//.test(url)) blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:approvalText('web',source.locale)},url}]});
  blocks.push(navigation(source)); return modal(source,'livo_approval_detail',blocks);
}
export function approvalConfirmModal(item: ApprovalEntry, control: ApprovalControl, source: Row, commandId: string, comment = '', notice?: string): Row {
  const blocks = [section(`${approvalText(control.operation,source.locale)} · ${text(item.task.task_key,80)} · ${text(item.task.title,220)}`),
    section(transition(item,source)),section(`${approvalText('step',source.locale)} ${control.step} · ${approvalText('version',source.locale)} ${control.version}`)];
  if (notice) blocks.unshift(section(approvalText(notice,source.locale)));
  if (control.operation !== 'withdraw') blocks.push({type:'input',block_id:'approval_comment',optional:true,label:{type:'plain_text',text:approvalText('comment',source.locale)},
    element:{type:'plain_text_input',action_id:'comment',multiline:true,max_length:3000,...(comment ? {initial_value:comment} : {})}});
  return modal(source,'livo_approval_confirm',blocks,{submit:{type:'plain_text',text:approvalText('confirm',source.locale)},
    private_metadata:JSON.stringify({...sourceMetadata(source),control,commandId})});
}
export const approvalSubmitButton = (taskId: string, locale?: string): Row => button('livo_approval_submit',approvalText('submit',locale),{taskId});
const submitMetadata = (source: Row, fields: Row): string => {
  const value=JSON.stringify({...sourceMetadata(source),...fields});
  if (value.length>2900) throw new ApprovalCommandError('approval_invalid_input');
  return value;
};
export function parseApprovalSubmitDraft(value: unknown): ApprovalSubmitDraft | null {
  try {
    const v=typeof value==='string'?JSON.parse(value):value;
    if (!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).some(key=>!['taskId','expected','targets','cursor','commandId'].includes(key)) ||
      !Array.isArray(v.targets) || v.targets.length>8 || !Number.isSafeInteger(v.cursor) || v.cursor<0 || v.cursor>1000000) return null;
    const command=parseApprovalCommand({commandId:v.commandId,operation:'submit',taskId:v.taskId,expected:v.expected,toStatusId:'unselected',expectedRuleId:null,enableRequirement:false}) as ApprovalSubmitCommand;
    const targets=v.targets.map((target:Row)=>{
      if (!target || typeof target!=='object' || Array.isArray(target) || Object.keys(target).some(key=>!['id','ruleId'].includes(key))) throw new Error('invalid');
      const parsed=parseApprovalCommand({...command,toStatusId:target.id,expectedRuleId:target.ruleId}) as ApprovalSubmitCommand;
      return {id:parsed.toStatusId,ruleId:parsed.expectedRuleId};
    });
    if (new Set(targets.map((target:Row)=>target.id)).size!==targets.length) return null;
    return {taskId:command.taskId,expected:command.expected,targets,cursor:v.cursor,commandId:command.commandId};
  } catch { return null; }
}
export function approvalSubmitSelectModal(preparation: ApprovalSubmitPreparation, source: Row, commandId: string): Row {
  const {task,targets}=preparation;
  const draft:ApprovalSubmitDraft={taskId:task.id,expected:preparation.expected,targets:targets.map(target=>({id:target.id,ruleId:target.ruleId})),cursor:preparation.cursor,commandId};
  const blocks:Row[]=[section(`${text(task.task_key,80)} · ${text(task.title,220)}\n${text(task.project_name,100)}`),section(approvalText('submitIntro',source.locale))];
  if (preparation.omitted) blocks.push(section(approvalText('omittedTargets',source.locale)));
  if (targets.length) blocks.push({type:'input',block_id:'approval_target',label:{type:'plain_text',text:approvalText('target',source.locale)},
    element:{type:'static_select',action_id:'target',options:targets.map((target,index)=>({text:{type:'plain_text',text:text(target.name,75)||'—'},value:String(index)}))}});
  else blocks.push(section(approvalText('noTargets',source.locale)));
  const paging:Row[]=[];
  if (preparation.cursor>0) paging.push(button('livo_approval_submit_page',approvalText('previous',source.locale),{cursor:Math.max(0,preparation.cursor-8)}));
  if (preparation.nextCursor!==null) paging.push(button('livo_approval_submit_page',approvalText('next',source.locale),{cursor:preparation.nextCursor}));
  if (paging.length) blocks.push({type:'actions',elements:paging});
  blocks.push(navigation(source));
  return modal(source,'livo_approval_submit_select',blocks,{...(targets.length?{submit:{type:'plain_text',text:approvalText('continue',source.locale)}}:{}),private_metadata:submitMetadata(source,{draft})});
}
export function approvalSubmitConfirmModal(preparation: ApprovalSubmitPreparation, target: ApprovalSubmitTarget, source: Row, command: ApprovalSubmitCommand): Row {
  const task=preparation.task,blocks:Row[]=[section(`${text(task.task_key,80)} · ${text(task.title,220)}`),
    section(`${approvalText('transition',source.locale)}: ${text(task.from_status_name,100)} → ${text(target.name,100)}`),
    section(approvalText(target.ruleId?'ruleMatched':'fallbackRule',source.locale)),section(approvalText('submitEffect',source.locale))];
  if (!command.expected.requiresApproval) {
    if (!command.expectedRuleId) blocks.push(section(approvalText('requirementNeeded',source.locale)));
    blocks.push({type:'input',block_id:'approval_requirement',optional:command.expectedRuleId!==null,label:{type:'plain_text',text:approvalText('requirement',source.locale)},
      element:{type:'checkboxes',action_id:'enable',options:[{text:{type:'plain_text',text:approvalText('enableRequirement',source.locale)},value:'enable'}]}});
  }
  return modal(source,'livo_approval_submit_confirm',blocks,{submit:{type:'plain_text',text:approvalText('submit',source.locale)},private_metadata:submitMetadata(source,{command})});
}
/** Uncertainty retries disclose no task content and preserve the exact mutation. */
export function approvalSubmitRetryModal(command: ApprovalSubmitCommand, source: Row): Row {
  return modal(source,'livo_approval_submit_retry',[section(approvalText('submitRetry',source.locale))],
    {submit:{type:'plain_text',text:approvalText('confirm',source.locale)},private_metadata:submitMetadata(source,{command})});
}
