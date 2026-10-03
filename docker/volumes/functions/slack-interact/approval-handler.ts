import { ApprovalCommandError, parseApprovalCommand, type ApprovalCommand } from '../approval-command/core.ts';
import type { Actions } from './handler.ts';
import type { Row } from './core.ts';
import type { ApprovalSubmitCommand } from './approval-backend.ts';
import { approvalConfirmModal, approvalDetailModal, approvalListModal, approvalNotice, approvalText, parseApprovalControl,
  approvalSubmitSelectModal, approvalSubmitConfirmModal, approvalSubmitRetryModal, parseApprovalSubmitDraft } from './approval-ui.ts';

const IDS = new Set(['livo_approval_open','approval_approve','approval_reject','approval_return','approval_withdraw','livo_approvals_page']);
const errorKey = (error: unknown) => {
  const code = error instanceof ApprovalCommandError ? error.code : '';
  if (['approval_conflict','approval_command_reused','approval_rule_changed','approval_pending'].includes(code)) return 'stale';
  if (['approval_legacy_snapshot','approval_snapshot_required'].includes(code)) return 'legacy';
  if (['approval_invalid_steps','approval_ambiguous_rule'].includes(code)) return 'invalidRule';
  if (code === 'approval_disabled') return 'disabled';
  if (code === 'approval_transport_error' || code === 'approval_unavailable') return 'uncertain';
  if (code === 'approval_transition_prerequisite') return 'prerequisite';
  return 'unavailable';
};
const busy = (key: string, source: Row) => {
  const view = approvalNotice(key,source); view.blocks = view.blocks.slice(0,1); return view;
};
const json = (value: string): Row => { try { const v = JSON.parse(value); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const personalSource = (p: Row, source: Row, actor?: Row): Row => ({
  ...source, user:p.user_id || p.user?.id || '', team:p.team_id || p.team?.id || '', ...(actor ? {locale:actor.locale} : {}), thread:'', echoExistingMessage:false,
});
/** The fallback is static text in a personal ephemeral response, never task content
 * or a channel message. A closed modal does not broaden disclosure. */
async function reopenReceipt(p: Row, source: Row, d: Actions, key = 'reopen') {
  const channel = source.channel, user = p.user_id || p.user?.id;
  if (/^[CGD][A-Z0-9]+$/.test(channel || '') && user)
    await d.slack('chat.postEphemeral',{channel,user,text:approvalText(key,source.locale)}).catch(()=>{});
}
const sameExpected = (a: Row,b: Row) => ['statusId','requiresApproval','currentApprovalId','approvalStatus'].every(key=>a[key]===b[key]);
const submitErrorKey = (error: unknown) => errorKey(error)==='stale'?'submitStale':errorKey(error);
/** Initial submission is separate from decisions on an existing request. Every
 * form keeps its original CAS fields and intent ID; only the actor is refreshed. */
async function handleInitialSubmit(p: Row, d: Actions, inputSource: Row): Promise<Row | undefined> {
  const action=p.type==='block_actions'?p.actions?.[0]:undefined;
  const slash=p.command && /^(submit|送簽|送签)(?:\s+(\S+))?\s*$/i.exec(String(p.text||'').trim());
  const callback=p.type==='view_submission'?p.view?.callback_id:'';
  const selecting=callback==='livo_approval_submit_select',confirming=callback==='livo_approval_submit_confirm',retrying=callback==='livo_approval_submit_retry';
  if (!slash && !['livo_approval_submit','livo_approval_submit_page'].includes(action?.action_id) && !selecting && !confirming && !retrying) return undefined;
  const source=personalSource(p,inputSource),approvals=d.approvals;
  const invalid=()=>({response_action:'update',view:approvalNotice('invalid',source)});
  if (selecting || confirming || retrying) {
    const metadata=json(p.view.private_metadata||'{}');
    if (selecting) {
      const draft=parseApprovalSubmitDraft(metadata.draft),index=p.view.state?.values?.approval_target?.target?.selected_option?.value;
      if (!draft || typeof index!=='string' || !/^\d$/.test(index) || !draft.targets[Number(index)]) return invalid();
      const chosen=draft.targets[Number(index)];
      d.background((async()=>{
        let view:Row;
        try {
          if (!approvals?.prepareSubmit || !(await d.enabled())) throw new ApprovalCommandError('approval_forbidden');
          const actor=await d.actor(p);source.locale=actor.locale;
          const prepared=await approvals.prepareSubmit(actor,draft.taskId,{cursor:draft.cursor});
          const target=prepared.targets.find(item=>item.id===chosen.id);
          if (!sameExpected(prepared.expected,draft.expected) || !target || target.ruleId!==chosen.ruleId) view=approvalNotice('submitStale',source);
          else {
            const command=parseApprovalCommand({commandId:draft.commandId,operation:'submit',taskId:draft.taskId,expected:draft.expected,
              toStatusId:chosen.id,expectedRuleId:chosen.ruleId,enableRequirement:false}) as ApprovalSubmitCommand;
            view=approvalSubmitConfirmModal(prepared,target,source,command);
          }
        } catch(error) {view=approvalNotice(submitErrorKey(error),source);}
        await d.slack('views.update',{view_id:p.view.id,view}).catch(()=>reopenReceipt(p,source,d,'submitReopen'));
      })());
      return {response_action:'update',view:busy('loading',source)};
    }
    let mutation:ApprovalSubmitCommand;
    try {
      const template=parseApprovalCommand(metadata.command);
      if (template.operation!=='submit') return invalid();
      if (retrying) mutation=template;
      else {
        const selected=p.view.state?.values?.approval_requirement?.enable?.selected_options??[];
        if (!Array.isArray(selected) || selected.length>1 || selected.some(option=>option?.value!=='enable')) return invalid();
        const enable=!template.expected.requiresApproval && selected.length===1;
        if (!template.expected.requiresApproval && template.expectedRuleId===null && !enable)
          return {response_action:'errors',errors:{approval_requirement:approvalText('requirementNeeded',source.locale)}};
        mutation={...template,enableRequirement:enable};
      }
    } catch {return invalid();}
    d.background((async()=>{
      let view:Row,saved=false;
      try {
        if (!approvals || !(await d.enabled())) throw new ApprovalCommandError('approval_forbidden');
        const actor=await d.actor(p);source.locale=actor.locale;
        const result=await approvals.command(actor,mutation);saved=true;
        try {
          if (!result.request?.id) throw new Error('missing request');
          const entry=await approvals.detail(actor,result.request.id);view=approvalDetailModal(entry,d.link(entry.task),source,'success');
        } catch {view=approvalNotice('success',source);}
      } catch(error) {
        view=saved?approvalNotice('success',source):errorKey(error)==='uncertain'?approvalSubmitRetryModal(mutation,source):approvalNotice(submitErrorKey(error),source);
      }
      await d.slack('views.update',{view_id:p.view.id,view}).catch(()=>reopenReceipt(p,source,d,'submitReopen'));
    })());
    return {response_action:'update',view:busy('saving',source)};
  }
  // Consume the short-lived Slack trigger before doing member/RLS reads.
  let opening:Row;
  try {
    opening=p.view?.id?await d.slack('views.update',{view_id:p.view.id,...(p.view.hash?{hash:p.view.hash}:{}),view:busy('loading',source)})
      :await d.slack('views.open',{trigger_id:p.trigger_id,view:busy('loading',source)});
  } catch {await reopenReceipt(p,source,d,'submitReopen');return {};}
  d.background((async()=>{
    let view:Row;
    try {
      if (!approvals?.prepareSubmit || !(await d.enabled())) throw new ApprovalCommandError('approval_forbidden');
      const actor=await d.actor(p);source.locale=actor.locale;
      const page=action?.action_id==='livo_approval_submit_page',meta=json(p.view?.private_metadata||'{}'),control=json(action?.value||'{}');
      const previous=page?parseApprovalSubmitDraft(meta.draft):null;
      if (page && (!previous || p.view?.callback_id!=='livo_approval_submit_select')) throw new ApprovalCommandError('approval_invalid_input');
      const taskId=slash?String(slash[2]||'').toUpperCase():page?previous!.taskId:control.taskId;
      const prepared=await approvals.prepareSubmit(actor,taskId,{byKey:!!slash,cursor:page?control.cursor:0});
      if (previous && !sameExpected(prepared.expected,previous.expected)) view=approvalNotice('submitStale',source);
      else view=approvalSubmitSelectModal(prepared,source,previous?.commandId||`slack-approval:${crypto.randomUUID()}`);
    } catch(error) {view=approvalNotice(submitErrorKey(error),source);}
    await d.slack('views.update',{view_id:opening.view?.id||p.view?.id,...(opening.view?.hash?{hash:opening.view.hash}:{}),view}).catch(()=>reopenReceipt(p,source,d,'submitReopen'));
  })());
  return {};
}
export async function handleApprovalInteraction(p: Row, d: Actions, inputSource: Row): Promise<Row | undefined> {
  const approvals = d.approvals;
  if (!approvals) return undefined;
  const initial=await handleInitialSubmit(p,d,inputSource);
  if (initial!==undefined) return initial;
  const action = p.type === 'block_actions' ? p.actions?.[0] : undefined;
  const command = p.command && /^approvals\s*$/i.test(String(p.text || '').trim());
  const submission = p.type === 'view_submission' && p.view?.callback_id === 'livo_approval_confirm';
  if (!command && !IDS.has(action?.action_id) && !submission) return undefined;
  const source = personalSource(p,inputSource);
  if (submission) {
    const metadata = json(p.view.private_metadata || '{}'), control = parseApprovalControl(metadata.control);
    const rawComment = p.view.state?.values?.approval_comment?.comment?.value ?? '';
    if (typeof rawComment !== 'string' || [...rawComment].length > 3000 || rawComment.includes('\0'))
      return {response_action:'errors',errors:{approval_comment:approvalText('tooLong',source.locale)}};
    let mutation: ApprovalCommand;
    try {
      if (!control || control.operation === 'open') throw new Error('invalid');
      mutation = parseApprovalCommand({commandId:metadata.commandId,operation:control.operation,requestId:control.requestId,expectedVersion:control.version,
        ...(control.operation === 'withdraw' ? {} : {expectedStep:control.step,comment:rawComment})});
    } catch { return {response_action:'update',view:approvalNotice('invalid',source)}; }
    // ACK before live feature/account/database checks. Preserve the modal's exact
    // displayed version/step; never replace it with a freshly fetched request.
    d.background((async()=>{
      let view: Row;
      let saved = false;
      try {
        if (!(await d.enabled())) throw new ApprovalCommandError('approval_forbidden');
        const actor = await d.actor(p); source.locale = actor.locale;
        const result = await approvals.command(actor,mutation); saved = true;
        try {
          const item = await approvals.detail(actor,result.request?.id || control!.requestId);
          view = approvalDetailModal(item,d.link(item.task),source,'success');
        } catch { view = approvalNotice('success',source); }
      } catch (error) {
        view = approvalNotice(saved ? 'success' : errorKey(error),source);
        if (!saved && errorKey(error) === 'uncertain') {
          try {
            const actor = await d.actor(p), item = await approvals.detail(actor,control!.requestId);
            // Keep the original ID/expectations/comment when retrying uncertainty.
            view = approvalConfirmModal(item,control!,source,mutation.commandId,rawComment,'uncertain');
          } catch { /* Do not disclose a request after visibility was revoked. */ }
        }
      }
      await d.slack('views.update',{view_id:p.view.id,view}).catch(()=>reopenReceipt(p,source,d));
    })());
    return {response_action:'update',view:busy('saving',source)};
  }
  let opening: Row;
  try {
    opening = p.view?.id ? await d.slack('views.update',{view_id:p.view.id,...(p.view.hash ? {hash:p.view.hash} : {}),view:busy('loading',source)})
      : await d.slack('views.open',{trigger_id:p.trigger_id,view:busy('loading',source)});
  } catch { await reopenReceipt(p,source,d); return {}; }
  d.background((async()=>{
    let view: Row;
    try {
      if (!(await d.enabled())) throw new ApprovalCommandError('approval_forbidden');
      const actor = await d.actor(p); source.locale = actor.locale;
      if (command || action?.action_id === 'livo_approvals_page') {
        const cursor = command ? 0 : json(action.value || '{}').cursor;
        view = approvalListModal(await approvals.list(actor,cursor),source);
      } else {
        const control = parseApprovalControl(action?.value);
        if (!control) view = approvalListModal(await approvals.list(actor,0),source,'oldButton');
        else {
          const expectedOperation = action.action_id === 'livo_approval_open' ? 'open' : action.action_id.replace('approval_','');
          if (control.operation !== expectedOperation) throw new ApprovalCommandError('approval_invalid_input');
          const item = await approvals.detail(actor,control.requestId);
          if (item.request.version !== control.version || item.request.current_step !== control.step) view = approvalNotice('stale',source);
          else if (control.operation === 'open') view = approvalDetailModal(item,d.link(item.task),source);
          else if (control.operation === 'withdraw' ? !item.canWithdraw : !item.canAct) throw new ApprovalCommandError('approval_forbidden');
          else view = approvalConfirmModal(item,control,source,`slack-approval:${crypto.randomUUID()}`);
        }
      }
    } catch (error) { view = approvalNotice(errorKey(error),source); }
    await d.slack('views.update',{view_id:opening.view?.id || p.view?.id,...(opening.view?.hash ? {hash:opening.view.hash} : {}),view}).catch(()=>reopenReceipt(p,source,d));
  })());
  return {};
}
