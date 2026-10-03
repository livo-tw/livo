import { describe, it, expect } from 'vitest';
import { applyReleaseCommand, canonicalReleaseJson, parseReleaseCommand, parseReleaseRequest, validReleaseResponse, type ReleaseBatch, type ReleaseContext, type ReleaseManifest } from '@/lib/releases/core';
const manifest:ReleaseManifest={title:'Example release',ownerId:'admin',components:[{id:'server',name:'Server',projectId:'project',taskIds:['task'],targets:[{environment:'Stage',build:'v1',config:'unchanged',data:'none'}]}]};
let sequence=0;
const ctx=():ReleaseContext=>({workspaceId:'default',actorId:'admin',role:'admin',now:'2026-10-03T00:00:00Z',newId:()=>`record-${++sequence}`,memberIds:new Set(['admin']),projectIds:new Set(['project']),taskProjects:new Map([['task','project']]),environments:['Stage'],qaSources:new Map()});
const command=(operation:string,rest:Record<string,unknown>={},version=0)=>parseReleaseCommand({commandId:`command-${++sequence}`,batchId:'batch',expectedVersion:version,operation,...rest});
const create=()=>applyReleaseCommand(null,command('create',{manifest}),ctx());
const apply=(batch:ReleaseBatch,operation:string,fields:Record<string,unknown>)=>applyReleaseCommand(batch,command(operation,fields,batch.version),ctx());
describe('release command trust boundary',()=>{
 it('rejects partial get/list/receipt payloads before they are considered successful',()=>{const b=create();expect(validReleaseResponse({action:'get',batchId:b.id},b)).toBe(true);expect(validReleaseResponse({action:'get',batchId:b.id},{...b,attempts:[{records:null}]})).toBe(false);expect(validReleaseResponse({action:'list',page:0},{batches:[b],page:0,hasMore:false})).toBe(true);expect(validReleaseResponse({action:'list',page:0},{batches:null,page:0,hasMore:false})).toBe(false);expect(validReleaseResponse({action:'receipt',commandId:'request-1',batchId:b.id},{found:'true'})).toBe(false);expect(validReleaseResponse({action:'receipt',commandId:'request-1',batchId:b.id},{found:true,result:{batch:{id:b.id}}})).toBe(false);});
 it('rejects client identities, unknown nested keys, non-calendar fields and prototype schemes',()=>{
  expect(()=>parseReleaseCommand({...command('create',{manifest}),actorId:'someone'})).toThrow('release_invalid_input');
  expect(()=>command('create',{manifest:{...manifest,components:[{...manifest.components[0],private:true}]}})).toThrow();
  expect(()=>command('link_evidence',{kind:'uat',componentId:'server',environment:'Stage',note:'checked',url:'javascript:alert(1)'})).toThrow();
  expect(()=>parseReleaseRequest({action:'list',page:-1})).toThrow();
 });
 it('uses canonical nested field order for identical retries',()=>expect(canonicalReleaseJson({z:{b:2,a:1},a:0})).toBe(canonicalReleaseJson({a:0,z:{a:1,b:2}})));
 it('rejects member writes, missing references, cross-project tasks and stale versions',()=>{
  const c=command('create',{manifest});expect(()=>applyReleaseCommand(null,c,{...ctx(),role:'member'})).toThrow('release_forbidden');
  expect(()=>applyReleaseCommand(null,c,{...ctx(),taskProjects:new Map([['task','hidden-project']])})).toThrow('release_reference_unavailable');
  const b=create();expect(()=>applyReleaseCommand(b,command('cancel',{note:'stop'},0),ctx())).toThrow('release_conflict');
 });
 it('binds approvals to manifest revision and retains the prior decision as history',()=>{
  let b=apply(create(),'request_exception',{scope:'Pending UAT',reason:'Explicit exception'}),id=b.exceptions[0].id;
  b=apply(b,'decide_exception',{exceptionId:id,decision:'approved',note:'Accepted'});
  b=apply(b,'edit_manifest',{manifest:{...manifest,title:'Updated release'}});
  expect(b.manifestRevision).toBe(2);expect(b.exceptions[0].revision).toBe(1);
  expect(()=>apply(b,'decide_exception',{exceptionId:id,decision:'approved',note:'Reuse'})).toThrow('release_exception_stale');
 });
 it('does not start a selected unresolved exception and rejects completion without actual recorded results',()=>{
  const b=apply(create(),'request_exception',{scope:'QA',reason:'Pending decision'});
  expect(()=>apply(b,'start_attempt',{environment:'Stage',componentIds:['server'],note:'Start'})).toThrow('release_confirmation_required');
  expect(()=>apply(create(),'complete',{note:'Done'})).toThrow('release_confirmation_required');
 });
 it('keeps immutable attempt snapshots, supports a failed retry and does not touch task/QA state',()=>{
  let b=apply(create(),'start_attempt',{environment:'Stage',componentIds:['server'],note:'Observed start'});
  b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'failed',note:'Failed',url:null});
  b=apply(b,'start_attempt',{environment:'Stage',componentIds:['server'],note:'Observed retry'});
  b=apply(b,'record_result',{attemptId:b.attempts[1].id,type:'deployed',note:'Verified deployment',url:null});
  b=apply(b,'complete',{note:'Confirmed complete'});expect(b.status).toBe('completed');expect(b.attempts[0].records[0].type).toBe('failed');
  expect(b.attempts[0].manifest.components[0].targets[0].build).toBe('v1');expect(Object.keys(b)).not.toContain('taskStatus');
 });
 it('requires exact QA version, fix-cycle, component, environment and build, then preserves source result',()=>{
  const b=create(),c=command('link_evidence',{componentId:'server',environment:'Stage',kind:'qa',note:'Applies to this configuration',url:null,issueId:'qa',targetId:'target',runId:'run',issueVersion:3},b.version);
  const context=ctx();context.qaSources.set('qa',{id:'qa',projectId:'project',version:3,fixCycle:2,targets:[{id:'target',environment:'Stage',component:'Server',build:'v1'}],runs:[{id:'run',targetId:'target',build:'v1',fixCycle:2,result:'fail'}]});
  const after=applyReleaseCommand(b,c,context);expect(after.evidence[0].qa?.result).toBe('fail');
  context.qaSources.get('qa')!.version=4;expect(()=>applyReleaseCommand(b,c,context)).toThrow('release_evidence_stale');
 });
 it('preserves archived environment records but refuses a new manifest with disabled values',()=>{
  const b=create();expect(()=>applyReleaseCommand(b,command('edit_manifest',{manifest},b.version),{...ctx(),environments:['Prod']})).toThrow('release_invalid_environment');
  expect(applyReleaseCommand(b,command('cancel',{note:'Keep history'},b.version),{...ctx(),environments:['Prod']}).status).toBe('cancelled');
  expect(()=>applyReleaseCommand(b,command('start_attempt',{environment:'Stage',componentIds:['server'],note:'New deployment'},b.version),{...ctx(),environments:['Prod']})).toThrow('release_invalid_environment');
 });
 it('requires all declared component/environment targets before completion, not just any successful attempt',()=>{
  const c2={...manifest.components[0],id:'frontend',name:'Web',targets:[...manifest.components[0].targets,{environment:'Prod',build:'v1',config:'unchanged',data:'none'}]};
  let b=applyReleaseCommand(null,command('create',{manifest:{...manifest,components:[manifest.components[0],c2]}}),{...ctx(),environments:['Stage','Prod']});
  b=apply(b,'start_attempt',{environment:'Stage',componentIds:['server'],note:'Only server'});b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'deployed',note:'Done',url:null});
  expect(()=>apply(b,'complete',{note:'Cannot skip web or production'})).toThrow('release_confirmation_required');
 });
 it('allows managers to record history when the project or owner has become inactive',()=>{
  let b=apply(create(),'start_attempt',{environment:'Stage',componentIds:['server'],note:'Observed'});
  b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'deployed',note:'Observed',url:null});
  const context={...ctx(),memberIds:new Set<string>(),projectIds:new Set<string>(),taskProjects:new Map<string,string>()};
  expect(applyReleaseCommand(b,command('record_result',{attemptId:b.attempts[0].id,type:'rollback',note:'Restore recorded',url:null},b.version),context).attempts[0].records.at(-1)?.type).toBe('rollback');
 });
 it('does not complete if a new unresolved exception was added after the attempt started',()=>{
  let b=apply(create(),'start_attempt',{environment:'Stage',componentIds:['server'],note:'Observed'});b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'deployed',note:'Observed',url:null});b=apply(b,'request_exception',{scope:'UAT follow-up',reason:'Needs approval'});expect(()=>apply(b,'complete',{note:'Finish'})).toThrow('release_confirmation_required');
 });
 it('requires explicit publication confirmation and trusted signed Slack context',()=>{
  const b=create(),c=command('publish_thread',{teamId:'TEXAMPLE',channelId:'CEXAMPLE',confirmed:true},b.version);
  expect(()=>applyReleaseCommand(b,c,ctx())).toThrow('release_forbidden');expect(()=>command('publish_thread',{teamId:'TEXAMPLE',channelId:'CEXAMPLE',confirmed:false},b.version)).toThrow('release_invalid_input');
  expect(applyReleaseCommand(b,c,{...ctx(),slackIdentity:{bindingId:'binding',teamId:'TEXAMPLE',userId:'UADMIN'}}).version).toBe(2);
 });
 it.each(['completed','cancelled'] as const)('permits only historical follow-up on %s batches without reopening them',status=>{
  let b=apply(create(),'start_attempt',{environment:'Stage',componentIds:['server'],note:'Observed'});b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'deployed',note:'Observed',url:null});b=apply(b,status==='completed'?'complete':'cancel',{note:'Original closure'});
  b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'rollback',note:'Rollback after closure',url:null});b=apply(b,'record_result',{attemptId:b.attempts[0].id,type:'recovery',note:'Recovered',url:null});b=apply(b,'record_maintenance',{type:'start',impact:'Service',note:'Observed maintenance'});b=apply(b,'record_maintenance',{type:'end',impact:'Service',note:'Maintenance ended'});expect(b.status).toBe(status);expect(b.closureNote).toBe('Original closure');expect(()=>apply(b,'start_attempt',{environment:'Stage',componentIds:['server'],note:'Not permitted'})).toThrow('release_closed');
 });
});
