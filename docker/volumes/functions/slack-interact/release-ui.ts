import type {Row} from './core.ts';
import {parseReleaseCommand,canonicalReleaseJson,ReleaseError,type ReleaseBatch,type ReleaseCommand,type ReleasePage,type ReleaseEventPage} from './release-core.ts';
export const RELEASE_WORDS:Record<string,[string,string,string]>={
 frozen:['重試會沿用原本內容與版本；若要修改，請另外開啟新表單。','重试会沿用原内容和版本；如需修改，请另开新表单。','Retry preserves the original content and version. Open a new form to make changes.'],
 recovered:['原操作已儲存；這次重送的內容沒有另行套用。若有修改，請另開新表單。','原操作已保存；此次重送的内容没有另行应用。如有修改，请另开新表单。','The original operation was saved. This resubmission made no further changes. Open a new form to apply edits.'],
 publish_thread:['在此頻道建立持續討論串','在此频道创建持续讨论串','Publish thread here'],publish_confirm:['確認在此頻道持續更新批次摘要。私人備註與證據內文不會發送。此批次的通知頻道將固定。','确认在此频道持续更新批次摘要。私人备注与证据正文不会发送。此批次通知频道将固定。','Confirm ongoing release summaries in this channel. Private notes and evidence are excluded. This release remains linked to this channel.'],pending:['等待核准','等待批准','Pending decision'],create:['建立批次','创建批次','Created release'],edit_manifest:['更新清單修訂','更新清单修订','Updated manifest'],link_evidence:['連結驗證證據','关联验证证据','Linked evidence'],decide_exception:['記錄例外決議','记录例外决议','Recorded exception decision'],start_attempt:['記錄開始發布','记录开始发布','Recorded start'],record_result:['記錄發布結果','记录发布结果','Recorded result'],record_maintenance:['記錄維護狀態','记录维护状态','Recorded maintenance'],
 title:['發布批次','发布批次','Releases'],close:['關閉','关闭','Close'],save:['確認儲存','确认保存','Confirm'],loading:['正在載入…','正在加载…','Loading…'],saving:['正在儲存…','正在保存…','Saving…'],saved:['已儲存發布紀錄。','已保存发布记录。','Release record saved.'],
 list:['批次清單','批次清单','Release list'],new:['建立批次','创建批次','New release'],open:['查看','查看','Open'],prev:['上一頁','上一页','Previous'],next:['下一頁','下一页','Next'],empty:['目前沒有紀錄。','目前没有记录。','No records yet.'],
 overview:['概要','概要','Overview'],components:['元件與版本','组件与版本','Components and versions'],evidence:['驗證證據','验证证据','Evidence'],exceptions:['例外核准','例外批准','Exceptions'],attempts:['發布紀錄','发布记录','Attempts'],maintenance:['維護紀錄','维护记录','Maintenance'],events:['操作歷史','操作历史','History'],
 add_component:['新增元件','添加组件','Add component'],target:['新增／修改環境版本','新增／修改环境版本','Set environment versions'],edit:['修改名稱與負責人','修改名称与负责人','Edit release details'],
 name:['批次名稱','批次名称','Release name'],owner:['負責人','负责人','Owner'],project:['專案','项目','Project'],component:['元件名稱','组件名称','Component name'],environment:['部署環境','部署环境','Environment'],build:['Build／程式版本','Build／程序版本','Build version'],config:['設定版本（未變更請填明）','配置版本（未变更请注明）','Config version (state unchanged)'],data:['資料／遷移版本（無變更請填明）','数据／迁移版本（无变更请注明）','Data/migration version'],tasks:['關聯卡片（先選專案）','关联卡片（先选项目）','Linked tasks (select project first)'],
 note:['紀錄／確認依據','记录／确认依据','Note / confirmation evidence'],url:['證據連結（可留空）','证据链接（可留空）','Evidence URL (optional)'],scope:['例外範圍','例外范围','Exception scope'],reason:['例外原因','例外原因','Exception reason'],impact:['維護影響範圍','维护影响范围','Maintenance impact'],
 start:['記錄開始發布','记录开始发布','Record start'],deployed:['記錄部署完成','记录部署完成','Record deployed'],failed:['記錄發布失敗','记录发布失败','Record failed'],rollback:['記錄回滾','记录回滚','Record rollback'],recovery:['確認恢復','确认恢复','Confirm recovery'],
 uat:['新增 UAT 確認','添加 UAT 确认','Add UAT evidence'],qa:['連結 QA 證據','关联 QA 证据','Link QA evidence'],issueId:['QA ID','QA ID','QA ID'],issueVersion:['QA 紀錄版號','QA 记录版号','QA record version'],targetId:['QA Target ID','QA Target ID','QA target ID'],runId:['QA Run ID','QA Run ID','QA run ID'],
 request_exception:['提出例外','提出例外','Request exception'],approved:['核准例外','批准例外','Approve exception'],rejected:['拒絕例外','拒绝例外','Reject exception'],maintenance_start:['記錄開始維護','记录开始维护','Start maintenance'],maintenance_end:['記錄維護結束','记录维护结束','End maintenance'],complete:['確認批次完成','确认批次完成','Complete release'],cancel:['取消批次','取消批次','Cancel release'],retry:['重試同一操作','重试同一操作','Retry this operation'],
 manual:['這裡只記錄人工操作與證據，不會執行部署或改變任務／QA 狀態。','这里只记录人工操作与证据，不会执行部署或改变任务／QA状态。','Records human actions and evidence only; does not deploy or change task/QA status.'],
 stale:['先前清單修訂的歷史紀錄','先前清单修订的历史记录','Historical manifest revision'],draft:['草稿','草稿','Draft'],active:['進行中','进行中','Active'],completed:['已完成','已完成','Completed'],cancelled:['已取消','已取消','Cancelled'],
 release_invalid_input:['表單不完整，請重新開啟。','表单不完整，请重新打开。','The form is incomplete. Reopen it.'],release_conflict:['資料已更新，本次未儲存。請重新查看批次。','数据已更新，本次未保存。请重新查看批次。','This release changed. Nothing was saved; reopen it.'],release_forbidden:['目前沒有操作權限，請確認綁定與管理權限。','目前没有操作权限，请确认绑定和管理权限。','Your current account cannot perform this action.'],release_unavailable:['暫時無法確認結果。請稍後查閱批次歷史，勿重複建立。','暂时无法确认结果。请稍后查看批次历史，勿重复创建。','The result is uncertain. Check release history before creating another record.'],release_transport_error:['無法確認儲存結果，可重試同一操作。','无法确认保存结果，可重试同一操作。','The result is uncertain. Retry this same operation.'],
 release_not_found:['批次或引用已無法存取。','批次或引用已无法访问。','This release or reference is unavailable.'],release_reference_unavailable:['引用資料已變更或無法存取，請重新選擇。','引用数据已变更或无法访问，请重新选择。','A reference changed or is unavailable. Select it again.'],release_invalid_environment:['環境已停用，請重新選擇目前可用環境。','环境已停用，请重新选择可用环境。','This environment is no longer available for a new plan.'],release_evidence_stale:['QA 版本或目標不符，請重新核對證據。','QA版本或目标不符，请重新核对证据。','The QA version or target differs. Review the evidence again.'],release_exception_stale:['例外已處理或屬於舊版清單，不能沿用。','例外已处理或属于旧版清单，不能沿用。','This exception was decided or belongs to an older manifest.'],release_confirmation_required:['尚有未完成的目標、例外或維護確認，請先核對。','仍有未完成目标、例外或维护确认，请先核对。','Targets, exception decisions or maintenance confirmations remain incomplete.'],release_invalid_transition:['目前紀錄不允許這項結果，請重新查看。','当前记录不允许此结果，请重新查看。','This result is not valid for the current record.'],release_closed:['批次已完成或取消，請查看歷史紀錄。','批次已完成或取消，请查看历史记录。','This release is completed or cancelled. View its history.'],release_command_reused:['此表單已提交其他內容，請重新開啟。','此表单已提交其他内容，请重新打开。','This form was used with different content. Reopen it.'],release_limit_reached:['批次已達內容上限，請拆分新的批次。','批次已达内容上限，请拆分新批次。','This release reached its size limit. Split out a new release.'],release_unauthorized:['登入綁定已失效，請重新開啟。','登录绑定已失效，请重新打开。','Your session expired. Reopen this view.'],
};
export const releaseText=(key:string,locale='zh-TW')=>(RELEASE_WORDS[key]||RELEASE_WORDS.release_unavailable)[locale.startsWith('en')?2:/CN|Hans/i.test(locale)?1:0];
const plain=(v:unknown,max=2900):Row=>{const text=String(v??'—')||'—';return {type:'plain_text',text:text.length>max?text.slice(0,max-1)+'…':text};};
const section=(v:unknown):Row=>({type:'section',text:plain(v)});
const button=(key:string,action:string,value:Row,s:Row):Row=>({type:'button',action_id:`${action}:${key}`,text:plain(releaseText(key,s.locale),75),value:JSON.stringify(value)});
const actions=(elements:Row[]):Row=>({type:'actions',elements});
const meta=(source:Row)=>Object.fromEntries(['channel','user','team','locale'].filter(k=>typeof source[k]==='string').map(k=>[k,String(source[k]).slice(0,150)]));
const modal=(blocks:Row[],source:Row,extra:Row={},submit=false):Row=>({type:'modal',callback_id:submit?'livo_release_save':'livo_release_view',title:plain(releaseText('title',source.locale),24),close:plain(releaseText('close',source.locale),24),...(submit?{submit:plain(releaseText('save',source.locale),24)}:{}),private_metadata:JSON.stringify({...meta(source),...extra}),blocks});
const nav=(s:Row)=>actions([button('list','livo_release_list',{page:0},s),button('new','livo_release_new',{},s)]);
export function releaseNotice(key:string,s:Row){return modal([section(releaseText(key,s.locale)),nav(s)],s);}
/** The retry survives a process restart: complete field values stay in Slack's view, never a worker Map. */
export async function releaseInputFingerprint(view:Row):Promise<string>{
 const m=JSON.parse(view.private_metadata||'{}'),values=view.state?.values||{},fields:Row={};
 for(const [block,row] of Object.entries(values))fields[block]=Object.fromEntries(Object.entries(row as Row).map(([id,v]:[string,Row])=>[id,v.selected_options?v.selected_options.map((o:Row)=>o.value).sort():v.selected_option?.value??v.value??null]));
 const payload=canonicalReleaseJson({form:m.form,batchId:m.batchId,commandId:m.commandId,version:m.version,teamId:m.teamId,channelId:m.channelId,fields});
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload)))].map(x=>x.toString(16).padStart(2,'0')).join('');
}
export function releasePendingForm(view:Row,s:Row,key:string,fingerprint:string):Row{
 const values=view.state?.values||{},blocks=(view.blocks||[]).filter((b:Row)=>b.block_id!=='release_retry_status').map((raw:Row)=>{const block=structuredClone(raw);if(block.type==='input'){
  const state=values[block.block_id]?.[block.element?.action_id];if(state){delete block.element.initial_value;delete block.element.initial_option;delete block.element.initial_options;
   if(state.value!=null)block.element.initial_value=state.value;if(state.selected_option)block.element.initial_option=state.selected_option;if(state.selected_options?.length)block.element.initial_options=state.selected_options;
  }}return block;});
 const result=modal([{...section(`${releaseText(key,s.locale)}\n${releaseText('frozen',s.locale)}`),block_id:'release_retry_status'},...blocks],s,{...JSON.parse(view.private_metadata||'{}'),fieldsHash:fingerprint},true);
 result.submit=plain(releaseText('retry',s.locale),24);return result;
}
export function releaseList(page:ReleasePage,s:Row){return modal([...page.batches.flatMap(b=>[section(`${b.title}\n${b.id} · ${releaseText(b.status,s.locale)} · r${b.manifestRevision}`),actions([button('open','livo_release_open',{batchId:b.id},s)])]),...(!page.batches.length?[section(releaseText('empty',s.locale))]:[]),actions([...(page.page?[button('prev','livo_release_list',{page:page.page-1},s)]:[]),...(page.hasMore?[button('next','livo_release_list',{page:page.page+1},s)]:[]),button('new','livo_release_new',{},s)])],s);}
export function releaseDetail(b:ReleaseBatch,s:Row,sectionName='overview',page=0,events?:ReleaseEventPage,canManage=false){
 const value={batchId:b.id,version:b.version},blocks:Row[]=[section(`${b.title}\n${b.id} · ${releaseText(b.status,s.locale)} · r${b.manifestRevision}`),section(releaseText('manual',s.locale))];
 const keys=['overview','components','evidence','exceptions','attempts','maintenance','events'];for(let i=0;i<keys.length;i+=4)blocks.push(actions(keys.slice(i,i+4).map(key=>button(key,'livo_release_open',{...value,section:key,page:0},s))));
 const all:Row[]=sectionName==='components'?b.components:sectionName==='evidence'?b.evidence:sectionName==='exceptions'?b.exceptions:sectionName==='attempts'?b.attempts:sectionName==='maintenance'?b.maintenance:sectionName==='events'?events?.events||[]:[];
 const rows=sectionName==='events'?all:all.slice(page*8,page*8+8);
 for(const row of rows){
  let text='';if(sectionName==='components')text=`${row.name} · ${row.projectId}\n${row.targets.map((t:Row)=>`${t.environment}: ${t.build} / ${t.config} / ${t.data}`).join('\n')}\n${row.taskIds.join(', ')}`;
  else if(sectionName==='evidence')text=`r${row.revision} · ${row.kind.toUpperCase()} · ${row.componentId} / ${row.environment}\n${row.note}\n${row.qa?`${row.qa.issueId} / ${row.qa.runId} / ${row.qa.result}`:''}`;
  else if(sectionName==='exceptions')text=`r${row.revision} · ${row.scope}\n${row.reason}\n${releaseText(row.decision,s.locale)}${row.decisionNote?' · '+row.decisionNote:''}`;
  else if(sectionName==='attempts')text=`r${row.revision} · ${row.environment} · ${row.componentIds.join(', ')}\n${row.note}\n${row.records.map((r:Row)=>`${releaseText(r.type,s.locale)} · ${r.createdAt} · ${r.note}`).join('\n')}`;
  else if(sectionName==='maintenance')text=`r${row.revision} · ${releaseText('maintenance_'+row.type,s.locale)}\n${row.impact}\n${row.note}`;
  else text=`v${row.version} · r${row.revision} · ${releaseText(row.operation,s.locale)}\n${row.actorId} · ${row.createdAt}`;
  blocks.push(section(text));if(canManage){
   const closed=['completed','cancelled'].includes(b.status);
   if(!closed&&sectionName==='components')blocks.push(actions(['target','qa','uat'].map(form=>button(form,'livo_release_form',{...value,form,componentId:row.id},s))));
   if(!closed&&sectionName==='exceptions'&&row.decision==='pending'&&row.revision===b.manifestRevision)blocks.push(actions(['approved','rejected'].map(form=>button(form,'livo_release_form',{...value,form,exceptionId:row.id},s))));
   if(sectionName==='attempts')blocks.push(actions((closed?['rollback','recovery']:['deployed','failed','rollback','recovery']).map(form=>button(form,'livo_release_form',{...value,form,attemptId:row.id},s))));
  }
 }
 if(sectionName==='overview')blocks.push(section(`${releaseText('owner',s.locale)}: ${b.ownerId}\n${b.components.map(c=>c.name).join(' · ')}`));else if(!rows.length)blocks.push(section(releaseText('empty',s.locale)));
 if(canManage&&!['completed','cancelled'].includes(b.status)){const forms=['edit','add_component','start','request_exception','maintenance_start','maintenance_end','complete','cancel'];for(let i=0;i<forms.length;i+=4)blocks.push(actions(forms.slice(i,i+4).map(form=>button(form,'livo_release_form',{...value,form},s))));}
 if(canManage&&['completed','cancelled'].includes(b.status))blocks.push(actions(['maintenance_start','maintenance_end'].map(form=>button(form,'livo_release_form',{...value,form},s))));
 if(canManage&&/^C[A-Z0-9]+$/.test(s.channel||''))blocks.push(actions([button('publish_thread','livo_release_form',{...value,form:'publish_thread'},s)]));
 const hasMore=sectionName==='events'?!!events?.hasMore:all.length>page*8+8;
 if(page||hasMore)blocks.push(actions([...(page?[button('prev','livo_release_open',{...value,section:sectionName,page:page-1},s)]:[]),...(hasMore?[button('next','livo_release_open',{...value,section:sectionName,page:page+1},s)]:[])]));blocks.push(nav(s));return modal(blocks,s);
}
const option=(value:string,label=value)=>({text:plain(label,75),value});
const input=(key:string,element:Row,s:Row,optional=false):Row=>({type:'input',block_id:key,label:plain(releaseText(key,s.locale),200),optional,element:{...element,action_id:element.action_id||'value'}});
const textInput=(key:string,s:Row,value?:string,optional=false)=>input(key,{type:'plain_text_input',...(value?{initial_value:value}:{}),max_length:['note','reason','url'].includes(key)?2000:250},s,optional);
export function releaseForm(form:string,base:Row,s:Row,b:ReleaseBatch|undefined,environments:string[]):Row {
 const blocks:Row[]=[section(releaseText('manual',s.locale))];
 if(['deployed','failed','rollback','recovery'].includes(form)){
  const attempt=b?.attempts.find(a=>a.id===base.attemptId);if(!attempt)throw new ReleaseError('release_reference_unavailable');
  blocks.push(section(`${attempt.manifest.title}\nr${attempt.revision} · ${attempt.environment}`));
  for(const component of attempt.manifest.components.filter(c=>attempt.componentIds.includes(c.id))){const target=component.targets.find(t=>t.environment===attempt.environment);if(!target)throw new ReleaseError('release_reference_unavailable');blocks.push(section(`${component.name}\n${releaseText('build',s.locale)}: ${target.build}\n${releaseText('config',s.locale)}: ${target.config}\n${releaseText('data',s.locale)}: ${target.data}`));}
 }
 if(form==='new'||form==='edit'){blocks.push(textInput('name',s,b?.title),input('owner',{type:'external_select',action_id:'livo_release_owner',min_query_length:0,...(b?{initial_option:option(b.ownerId)}:{})},s));}
 if(form==='new'||form==='add_component'){blocks.push(input('project',{type:'external_select',action_id:'livo_release_project',min_query_length:0},s),textInput('component',s),input('tasks',{type:'multi_external_select',action_id:'livo_release_tasks',min_query_length:0,max_selected_items:50},s,true));}
 if(['new','add_component','target','qa','uat','start'].includes(form))blocks.push(input('environment',{type:'static_select',options:environments.map(e=>option(e))},s));
 if(['new','add_component','target'].includes(form))for(const key of ['build','config','data'])blocks.push(textInput(key,s));
 if(form==='start')blocks.push(input('components',{type:'multi_static_select',options:b!.components.map(c=>option(c.id,c.name))},s));
 if(form==='qa')for(const [key,kind] of [['issueId','issue'],['targetId','target'],['runId','run']])blocks.push(input(key,{type:'external_select',action_id:`livo_release_qa_${kind}`,min_query_length:0},s));
 if(form==='request_exception')blocks.push(textInput('scope',s),textInput('reason',s));
 if(form.startsWith('maintenance_'))blocks.push(textInput('impact',s));
 if(form==='publish_thread')blocks.push(section(releaseText('publish_confirm',s.locale)),section(base.channelId));
 if(!['new','edit','add_component','target','request_exception','publish_thread'].includes(form))blocks.push(textInput('note',s));
 if(['qa','uat','deployed','failed','rollback','recovery'].includes(form))blocks.push(textInput('url',s,undefined,true));
 return modal(blocks,s,{form,...base},true);
}
export function releaseSubmission(view:Row,batch?:ReleaseBatch):ReleaseCommand {
 const m=JSON.parse(view.private_metadata||'{}'),state=view.state?.values||{};
 const field=(key:string)=>{const v=state[key]?.value??Object.values(state[key]||{})[0] as Row;return v?.selected_option?.value??v?.value??'';};
 const form=m.form,base={commandId:m.commandId,batchId:m.batchId,expectedVersion:m.version};
 if(form!=='new'&&(!batch||batch.id!==m.batchId||batch.version!==m.version))throw new ReleaseError('release_conflict',409);
 let input:Row;
 if(['new','edit','add_component','target'].includes(form)){
  const manifest=batch?{title:batch.title,ownerId:batch.ownerId,components:structuredClone(batch.components)}:{title:'',ownerId:'',components:[] as Row[]};
  if(form==='new'||form==='edit'){manifest.title=field('name');manifest.ownerId=field('owner');}
  const target={environment:field('environment'),build:field('build'),config:field('config'),data:field('data')};
  if(form==='new'||form==='add_component')manifest.components.push({id:m.componentId,name:field('component'),projectId:field('project'),taskIds:(state.tasks?.livo_release_tasks?.selected_options||[]).map((v:Row)=>v.value),targets:[target]});
  if(form==='target'){const c=manifest.components.find(c=>c.id===m.componentId);if(!c)throw new ReleaseError('release_reference_unavailable');const index=c.targets.findIndex((t:Row)=>t.environment===target.environment);if(index<0)c.targets.push(target);else c.targets[index]=target;}
  input={...base,operation:form==='new'?'create':'edit_manifest',manifest};
 } else if(form==='qa'||form==='uat'){const issue=form==='qa'?JSON.parse(field('issueId')||'null'):null;input={...base,operation:'link_evidence',kind:form,componentId:m.componentId,environment:field('environment'),note:field('note'),url:field('url')||null,...(form==='qa'?{issueId:issue?.id,issueVersion:issue?.version,targetId:field('targetId'),runId:field('runId')}:{})};}
 else if(form==='request_exception')input={...base,operation:'request_exception',scope:field('scope'),reason:field('reason')};
 else if(form==='approved'||form==='rejected')input={...base,operation:'decide_exception',exceptionId:m.exceptionId,decision:form,note:field('note')};
 else if(form==='start')input={...base,operation:'start_attempt',environment:field('environment'),componentIds:(state.components?.value?.selected_options||[]).map((v:Row)=>v.value),note:field('note')};
 else if(['deployed','failed','rollback','recovery'].includes(form))input={...base,operation:'record_result',attemptId:m.attemptId,type:form,note:field('note'),url:field('url')||null};
 else if(form==='maintenance_start'||form==='maintenance_end')input={...base,operation:'record_maintenance',type:form.endsWith('start')?'start':'end',impact:field('impact'),note:field('note')};
 else if(form==='publish_thread')input={...base,operation:form,teamId:m.teamId,channelId:m.channelId,confirmed:true};
 else input={...base,operation:form,note:field('note')};
 return parseReleaseCommand(input);
}
