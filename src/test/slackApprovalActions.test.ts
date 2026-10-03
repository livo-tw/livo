// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { createApprovalData, executeSlackApprovalCommand, type ApprovalEntry } from '../../docker/volumes/functions/slack-interact/approval-backend';
import { APPROVAL_TEXT, approvalConfirmModal, approvalDetailModal, approvalControl, parseApprovalControl } from '../../docker/volumes/functions/slack-interact/approval-ui';
import { ApprovalCommandError, type ApprovalCommandResult, type ApprovalCommand } from '../../docker/volumes/functions/approval-command/core';
import type { Row } from '../../docker/volumes/functions/slack-interact/core';

const actor: Row = { id:'member-1',team:'TEXAMPLE',slack_user:'UEXAMPLE',jwt:'verified-member-session',role:'admin',locale:'zh-TW' };
const source: Row = { team:'TEXAMPLE',user:'UEXAMPLE',channel:'CEXAMPLE',thread:'unrelated-thread',locale:'zh-TW' };
const item: ApprovalEntry = { request:{id:'request-1',task_id:'task-1',rule_id:null,requested_by:'requester-1',from_status:'todo',to_status:'done',current_step:1,status:'pending',version:3,created_at:'2026-01-01',completed_at:null,
  steps_snapshot:[{step_order:1,approver_type:'role',approver_role:'admin',approver_user_id:null}]},task:{id:'task-1',title:'Private task title',task_key:'EX-1',requirement:'<p>Original 中文内容</p>',current_approval_id:'request-1'},canAct:true,canWithdraw:true,enabled:true,legacy:false };
const receipt: ApprovalCommandResult = {commandId:'command-example',eventId:'event-1',replayed:false,request:{...item.request,status:'approved',version:4},task:{id:'task-1',status_id:'done',requires_approval:true,current_approval_id:null,approval_status:null}};
const base: Row = {team:{id:actor.team},user:{id:actor.slack_user},trigger_id:'trigger-example'};
function setup() {
  const jobs: Promise<unknown>[] = [];
  const d: Actions = { enabled:vi.fn(async()=>true),heartbeat:vi.fn(async()=>{}),actor:vi.fn(async()=>actor),catalog:vi.fn(async()=>({})),search:vi.fn(async()=>[]),
    task:vi.fn(async()=>undefined),mapped:vi.fn(async()=>undefined),slack:vi.fn(async()=>({view:{id:'VIEW1',hash:'loading-hash'}})),reply:vi.fn(async()=>{}),
    commit:vi.fn(async()=>({})),deliver:vi.fn(async()=>{}),background:work=>jobs.push(work),link:()=> 'https://example.com/?task=EX-1',
    approvals:{list:vi.fn(async()=>({entries:[item],cursor:0,nextCursor:null,enabled:true})),detail:vi.fn(async()=>item),command:vi.fn(async()=>receipt)} };
  return {d,jobs,flush:async()=>{await Promise.all(jobs);},lastView:()=>vi.mocked(d.slack).mock.calls.filter(([m])=>m==='views.update').at(-1)?.[1].view as Row};
}
const click = (operation: 'open'|'approve'|'reject'|'return'|'withdraw' = 'approve', overrides: Row = {}): Row => ({...base,type:'block_actions',channel:{id:source.channel},
  actions:[{action_id:operation==='open'?'livo_approval_open':`approval_${operation}`,value:JSON.stringify({...approvalControl(item,operation),...overrides})}]});
const submit = (): Row => ({...base,type:'view_submission',view:{...approvalConfirmModal(item,approvalControl(item,'approve'),source,'command-example'),id:'VIEW1',hash:'form-hash',state:{values:{approval_comment:{comment:{value:'Reviewed'}}}}}});

describe('private Slack approval flow',()=>{
  it('consumes the trigger before live actor lookup and renders only in a modal',async()=>{
    const {d,flush,lastView}=setup();await handleInteraction({...base,command:'/livo',text:'approvals'},'event',d);await flush();
    expect(vi.mocked(d.slack).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.actor).mock.invocationCallOrder[0]);
    expect(lastView().callback_id).toBe('livo_approval_list');expect(d.reply).not.toHaveBeenCalled();expect(d.approvals!.command).not.toHaveBeenCalled();
    expect(vi.mocked(d.slack).mock.calls.every(([method])=>method.startsWith('views.'))).toBe(true);
  });
  it.each(['approve','reject','return','withdraw'] as const)('opens a confirmation for %s with unchanged expectations',async operation=>{
    const {d,flush,lastView}=setup();await handleInteraction(click(operation),'event',d);await flush();
    expect(lastView().callback_id).toBe('livo_approval_confirm');const metadata=JSON.parse(lastView().private_metadata);
    expect(metadata.control).toEqual(approvalControl(item,operation));expect(metadata.thread).toBeUndefined();expect(d.approvals!.command).not.toHaveBeenCalled();
  });
  it('refuses stale versions and cannot silently promote a button to the next step',async()=>{
    const {d,flush,lastView}=setup();vi.mocked(d.approvals!.detail).mockResolvedValue({...item,request:{...item.request,version:4,current_step:2}});
    await handleInteraction(click(),'event',d);await flush();expect(lastView().callback_id).toBe('livo_approval_notice');
    expect(JSON.stringify(lastView())).not.toContain('livo_approval_confirm');expect(d.approvals!.command).not.toHaveBeenCalled();
  });
  it('routes legacy raw IDs to a current list without executing them',async()=>{
    const {d,flush,lastView}=setup(),p=click();p.actions[0].value='request-1';await handleInteraction(p,'event',d);await flush();
    expect(lastView().callback_id).toBe('livo_approval_list');expect(d.approvals!.detail).not.toHaveBeenCalled();expect(d.approvals!.command).not.toHaveBeenCalled();
  });
  it('ACKs submission before feature lookup finishes and submits the displayed version',async()=>{
    const {d,flush,lastView}=setup();let finish!:(value:boolean)=>void;vi.mocked(d.enabled).mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
    const ack=await handleInteraction(submit(),'event',d);expect(ack.response_action).toBe('update');expect(d.actor).not.toHaveBeenCalled();
    finish(true);await flush();expect(d.approvals!.command).toHaveBeenCalledWith(actor,{commandId:'command-example',operation:'approve',requestId:'request-1',expectedVersion:3,expectedStep:1,comment:'Reviewed'});
    expect(vi.mocked(d.approvals!.command).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(d.approvals!.detail).mock.invocationCallOrder[0]);
    expect(JSON.stringify(lastView())).toContain('已儲存');
  });
  it('does not misreport a committed action when the follow-up read or modal fails',async()=>{
    const {d,flush,lastView}=setup();vi.mocked(d.approvals!.detail).mockRejectedValue(new Error('read failed'));
    await handleInteraction(submit(),'event',d);await flush();expect(JSON.stringify(lastView())).toContain('已儲存');expect(d.reply).not.toHaveBeenCalled();
  });
  it('keeps command ID, expected version and comment when the result is uncertain',async()=>{
    const {d,flush,lastView}=setup();vi.mocked(d.approvals!.command).mockRejectedValue(new ApprovalCommandError('approval_transport_error'));
    await handleInteraction(submit(),'event',d);await flush();expect(lastView().callback_id).toBe('livo_approval_confirm');
    expect(JSON.parse(lastView().private_metadata)).toMatchObject({commandId:'command-example',control:{version:3,step:1}});
    expect(lastView().blocks.find((b:Row)=>b.type==='input').element.initial_value).toBe('Reviewed');
  });
  it('uses only a generic ephemeral fallback when a private modal closes',async()=>{
    const {d,flush}=setup();vi.mocked(d.slack).mockRejectedValue(new Error('closed'));await handleInteraction(click(),'event',d);await flush();
    expect(d.reply).not.toHaveBeenCalled();const calls=vi.mocked(d.slack).mock.calls;
    expect(calls.some(([m])=>m==='chat.postMessage')).toBe(false);expect(calls.find(([m])=>m==='chat.postEphemeral')?.[1].text).not.toContain('Private task');
  });
  it('refreshes actor and permissions for each navigation, and refuses live disabled actions',async()=>{
    const {d,flush,lastView}=setup();vi.mocked(d.approvals!.detail).mockResolvedValue({...item,canAct:false,enabled:false});
    await handleInteraction(click(),'event',d);await flush();expect(lastView().callback_id).toBe('livo_approval_notice');expect(d.approvals!.command).not.toHaveBeenCalled();
    expect(d.actor).toHaveBeenCalledOnce();
  });
  it('keeps navigation hash-guarded and does not expose a previously visible task after read denial',async()=>{
    const {d,flush,lastView}=setup();const p={...base,type:'block_actions',view:{id:'VIEW1',hash:'old-view-hash',private_metadata:JSON.stringify(source)},
      actions:[{action_id:'livo_approvals_page',value:JSON.stringify({cursor:8})}]};
    await handleInteraction(p,'page',d);await flush();expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({hash:'old-view-hash'}));
    expect(d.slack).toHaveBeenCalledWith('views.update',expect.objectContaining({hash:'loading-hash'}));
    expect(d.approvals!.list).toHaveBeenCalledWith(actor,8);
    vi.mocked(d.approvals!.detail).mockRejectedValue(new ApprovalCommandError('approval_forbidden'));
    await handleInteraction(click('open'),'denied',d);await flush();expect(JSON.stringify(lastView())).not.toContain('Private task title');expect(d.reply).not.toHaveBeenCalled();
  });
  it('validates Slack comment limits before starting background work',async()=>{
    const {d,jobs}=setup(),p=submit();p.view.state.values.approval_comment.comment.value='a'.repeat(3001);
    expect((await handleInteraction(p,'event',d)).response_action).toBe('errors');expect(jobs).toHaveLength(0);
  });
  it('provides all three locales without translating user content or inserting mrkdwn',()=>{
    expect(Object.values(APPROVAL_TEXT).every(v=>v.length===3&&v.every(Boolean))).toBe(true);
    const zh=approvalDetailModal(item,'https://example.com',{locale:'zh-CN'}),en=approvalDetailModal(item,'https://example.com',{locale:'en-US'});
    expect(JSON.stringify(zh)).toContain('LIVO 签核');expect(JSON.stringify(en)).toContain('LIVO approvals');
    expect(JSON.stringify(en)).toContain('Original 中文内容');expect(JSON.stringify(en)).not.toContain('mrkdwn');
    expect(parseApprovalControl({...approvalControl(item,'approve'),actorId:'forged'})).toBeNull();
  });
});

describe('approval member-RLS adapter',()=>{
  function database(requests: Row[]) {
    let active=true,visible=true,enabled=true;
    const rows=vi.fn(async(table:string,q:Row={})=>{
      if(table==='members')return active?[{id:'member-1',role:'admin',is_active:true}]:[];
      if(table==='system_settings')return [{value:{approvals:enabled}}];
      if(table==='approval_requests')return q.id?requests.filter(r=>`eq.${r.id}`===q.id):requests.slice(Number(q.offset||0),Number(q.offset||0)+Number(q.limit||25));
      if(table==='tasks')return visible?[{...item.task,id:String(q.id).slice(3),current_approval_id:requests.find(r=>`eq.${r.task_id}`===q.id)?.id,projects:{id:'project-1',name:'Project',is_archived:false}}]:[];
      return [];
    });
    const db={rows,request:vi.fn()},execute=vi.fn(async()=>receipt),memberDb=vi.fn(()=>db);
    return {data:createApprovalData(memberDb,execute),rows,execute,memberDb,setActive:(v:boolean)=>{active=v;},setVisible:(v:boolean)=>{visible=v;},setEnabled:(v:boolean)=>{enabled=v;}};
  }
  it('paginates after authorization with no duplicate ninth item or hidden IDs',async()=>{
    const requests=Array.from({length:10},(_,i)=>({...item.request,id:`request-${i}`,task_id:`task-${i}`}));const {data,rows,memberDb}=database(requests);
    const first=await data.list(actor,0),second=await data.list(actor,first.nextCursor!);
    expect(first.entries).toHaveLength(8);expect(first.nextCursor).toBe(8);expect(second.entries).toHaveLength(2);expect(second.nextCursor).toBeNull();
    expect(memberDb).toHaveBeenCalledWith(actor);expect(rows.mock.calls.filter(([t])=>t==='tasks').every(([,q])=>q?.['projects.is_archived']==='eq.false')).toBe(true);
  });
  it('fails closed after member/visibility removal even for a previously visible request',async()=>{
    const db=database([item.request]);expect((await db.data.detail(actor,'request-1')).task.id).toBe('task-1');db.setVisible(false);
    await expect(db.data.detail(actor,'request-1')).rejects.toThrow('approval_forbidden');expect((await db.data.list(actor,0)).entries).toHaveLength(0);
    db.setActive(false);await expect(db.data.list(actor,0)).rejects.toThrow('approval_forbidden');
  });
  it('allows legacy withdrawal while feature OFF but rejects decisions',async()=>{
    const db=database([{...item.request,steps_snapshot:null}]);db.setEnabled(false);const page=await db.data.list(actor,0);
    expect(page.entries[0]).toMatchObject({legacy:true,canAct:false,canWithdraw:true,enabled:false});
    await expect(db.data.command(actor,{commandId:'command-example',operation:'approve',requestId:'request-1',expectedVersion:3,expectedStep:1,comment:null})).rejects.toThrow('approval_disabled');
    await db.data.command(actor,{commandId:'command-example',operation:'withdraw',requestId:'request-1',expectedVersion:3});expect(db.execute).toHaveBeenCalledOnce();
  });
  it('posts only the strict command with the verified JWT and repeats the same ID after transport failure',async()=>{
    const command:ApprovalCommand={commandId:'command-example',operation:'approve',requestId:'request-1',expectedVersion:3,expectedStep:1,comment:null};
    const fetcher=vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('timeout')).mockResolvedValue(new Response(JSON.stringify(receipt),{status:200}));
    const env={get:(key:string)=>key==='SUPABASE_URL'?'https://database.example.com':'public-key'};
    await executeSlackApprovalCommand(env,actor,command,fetcher);expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0][1]?.body).toBe(fetcher.mock.calls[1][1]?.body);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body))).toEqual(command);
    expect(fetcher.mock.calls[1][1]?.headers).toMatchObject({Authorization:'Bearer verified-member-session'});
    fetcher.mockReset().mockResolvedValue(new Response(JSON.stringify({error:'approval_forbidden'}),{status:403}));
    await expect(executeSlackApprovalCommand(env,actor,command,fetcher)).rejects.toThrow('approval_forbidden');expect(fetcher).toHaveBeenCalledOnce();
  });
});
