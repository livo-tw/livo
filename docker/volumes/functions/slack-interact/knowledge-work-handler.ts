import type { Actions } from './handler.ts';
import type { Row } from './core.ts';
import { KNOWLEDGE_SOURCE_KINDS, KnowledgeWorkError, knowledgeWorkError, parseKnowledgeWorkCommand, type KnowledgeWorkCommand } from './knowledge-work-core.ts';
import { knowledgeButton as button, knowledgeConfirm as confirm, knowledgeInput as input, knowledgeLabel as label, knowledgeModal as modal, knowledgeNotice as notice, knowledgePlain as plain } from './knowledge-work-ui.ts';

// Frozen actor/binding-scoped metadata survives Edge worker replacement. It stores
// selected source IDs/hashes and user notes, never retrieved private source bodies.
// Save reconstructs the preview under fresh ACL and checks its complete hash.
type Session={at:number;identity:string;source:Row;mode:string;choices:Map<string,Row>;page?:Row;preview?:Row;query?:Row;command?:KnowledgeWorkCommand;commandId:string;input?:Row;previewHash?:string;busy?:boolean};
const identity=(actor:Row)=>JSON.stringify([actor.id,actor.binding_id,actor.team,actor.slack_user]);
const searchQuery=(query='',effectiveOnly=false,types:string[]=KNOWLEDGE_SOURCE_KINDS)=>({operation:'search',query,types,projectIds:[] as string[],effectiveOnly,cursor:0});
const state=(p:Row,name:string)=>p.view?.state?.values?.[name]?.[name]||{};
const value=(p:Row,name:string)=>state(p,name).value?.trim()||null;
const decodeChoice=(raw:string|undefined):Row|undefined=>{if(!raw)return;try{const c=JSON.parse(raw);if(c.k==='predecessor')return {publicationId:c.i,publicationVersion:c.v};if(c.k==='destination')return {id:c.i,pageId:c.i,projectId:c.p};return {kind:c.k,id:c.i,version:c.v};}catch{throw new KnowledgeWorkError('knowledge_invalid_input');}};
const chosen=(p:Row,name:string,_s:Session)=>decodeChoice(state(p,name).selected_option?.value);
const digest=async(value:unknown)=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value))))).map(v=>v.toString(16).padStart(2,'0')).join('');
const sourceRef=(item:Row)=>({kind:item.kind,id:item.id,version:item.version});
function create(actor:Row,source:Row,mode:string):[string,Session] {
  const id=crypto.randomUUID(),s={at:Date.now(),identity:identity(actor),source:{channel:source.channel||'',locale:actor.locale},mode,commandId:crypto.randomUUID(),choices:new Map<string,Row>()};return [id,s];
}
function find(source:Row,actor:Row):[string,Session] {
  const frozen=source.kwState;if(!frozen||typeof frozen!=='object'||!Number.isFinite(frozen.at)||frozen.at<Date.now()-600000||frozen.at>Date.now()+10000||frozen.identity!==identity(actor)||typeof frozen.commandId!=='string')throw new KnowledgeWorkError('knowledge_unavailable',404);
  const s:Session={...frozen,source:{channel:source.channel||'',locale:actor.locale},choices:new Map<string,Row>()};return [source.kw||frozen.commandId,s];
}
const meta=(id:string,s:Session)=>{const p=s.page;const result={...s.source,kw:id,kwState:{at:s.at,identity:s.identity,mode:s.mode,commandId:s.commandId,...(p?{page:{pageId:p.pageId,pageVersion:p.pageVersion,metadata:{ownerId:p.metadata.ownerId},publication:p.publication?{id:p.publication.id}:null}}:{}),...(s.input?{input:s.input,previewHash:s.previewHash}:{}),...(s.query?{query:s.query}:{}),...(s.command&&s.command.operation!=='save_draft'?{command:s.command}:{})}};if(new TextEncoder().encode(JSON.stringify(result)).byteLength>2800)throw new KnowledgeWorkError('knowledge_incomplete_source',409);return result;};
const external=(name:string,key:string,s:Session,optional=false,multiple=false)=>input(name,label(key,s.source.locale),{type:multiple?'multi_external_select':'external_select',min_query_length:0,...(multiple?{max_selected_items:3}:{}),placeholder:{type:'plain_text',text:label(key,s.source.locale)}},optional);
const textInput=(name:string,key:string,s:Session,initial?:string,max=200,optional=false)=>input(name,label(key,s.source.locale),{type:'plain_text_input',max_length:max,...(max>200?{multiline:true}:{}),...(initial?{initial_value:initial}: {})},optional);
function draftForm(id:string,s:Session):Row {
  return modal([textInput('draftTitle','draftTitle',s,undefined,100,true),textInput('notes','notes',s,undefined,400,true),external('livo_kw_sources','sources',s,true,true),
    ...(s.mode==='weekly'?['from','to'].map(name=>input(name,label(name,s.source.locale),{type:'datepicker'},false)):[])],meta(id,s),'livo_knowledge_work',label('prepare',s.source.locale));
}
function previewForm(id:string,s:Session):Row {
  const preview=s.preview!;if(preview.coverage?.complete!==true||preview.coverage?.unavailable!==0)return notice('incomplete',meta(id,s));return modal([plain(label('previewNote',s.source.locale)),plain(preview.title),
    ...Array.from({length:Math.ceil(preview.text.length/2500)},(_,i)=>plain(preview.text.slice(i*2500,(i+1)*2500))),confirm(s.source.locale)],meta(id,s),'livo_knowledge_work',label('save',s.source.locale));
}
function detailForm(id:string,s:Session,d:Actions):Row {
  const page=s.page!,buttons:Row[]=[{type:'button',text:{type:'plain_text',text:label('open',s.source.locale)},url:d.knowledgeWork!.link(page.pageId)}];
  if(page.canEdit)buttons.push(...['metadata',...(page.privateDraftOwnerId?[]:['publish','replace']),'link'].map(action=>button('livo_kw_'+action,label(action,s.source.locale))));
  const blocks:Row[]=[plain(page.title),plain(label('partial',s.source.locale)),plain(String(page.body||'').replace(/<[^>]*>/g,' ').slice(0,2800)),{type:'actions',elements:buttons.slice(0,5)}];
  const extra:Row[]=[];if(buttons.length>5)extra.push(...buttons.slice(5));if(page.canShare)extra.push(button('livo_kw_share',label('share',s.source.locale)));
  if(extra.length)blocks.push({type:'actions',elements:extra} as Row);
  for(const ref of (page.linkItems||[]).slice(0,20)){blocks.push(plain(ref.title));if(page.canEdit)blocks.push({type:'actions',elements:[button('livo_kw_unlink',label('unlink',s.source.locale),{kind:ref.kind,id:ref.id})]} as Row);}
  if((page.linkItems||[]).length>20)blocks.push(plain(label('partial',s.source.locale)));
  return modal(blocks,meta(id,s));
}
function editForm(id:string,s:Session):Row {
  const page=s.page!,locale=s.source.locale;let blocks:Row[]=[];
  if(s.mode==='metadata'){
    if(String(page.metadata.applicability.productVersion||'').length>100||String(page.metadata.applicability.environment||'').length>100||String(page.metadata.applicability.summary||'').length>300)return notice('incomplete',meta(id,s));
    const options=['specification','decision','unknown'].map(v=>({text:{type:'plain_text',text:label(v,locale)},value:v}));
    blocks=[input('kind',label('kind',locale),{type:'static_select',options,initial_option:options.find(o=>o.value===(page.metadata.documentKind||'unknown'))}),
      external('livo_kw_owner','owner',s,true),textInput('productVersion','productVersion',s,page.metadata.applicability.productVersion?.slice(0,100),100,true),textInput('environment','environment',s,page.metadata.applicability.environment?.slice(0,100),100,true),textInput('summary','summary',s,page.metadata.applicability.summary?.slice(0,300),300,true),plain(label('ownerNote',locale)),confirm(locale)];
  }else if(s.mode==='publish')blocks=[plain(page.title),plain(label('publishNote',locale)),confirm(locale)];
  else if(s.mode==='replace')blocks=[plain(page.title),plain(label('publishNote',locale)),external('livo_kw_predecessor','predecessor',s),confirm(locale)];
  else if(s.mode==='link')blocks=[external('livo_kw_source','sources',s),confirm(locale)];
  else if(s.mode==='unlink')blocks=[plain(s.query?.title||''),confirm(locale)];
  else if(s.mode==='share')blocks=[plain(label('shareNote',locale)),external('livo_kw_destination','destination',s,true),confirm(locale)];
  return modal(blocks,meta(id,s),'livo_knowledge_work',label(s.mode==='metadata'?'saveMetadata':s.mode,locale));
}
async function listing(id:string,s:Session,actor:Row,d:Actions):Promise<Row>{
  const result=await d.knowledgeWork!.request(actor,'query',s.query);const blocks:Row[]=[];
  for(const item of result.items||[]){blocks.push(plain(item.title));if(item.kind==='knowledge'||item.pageId)blocks.push({type:'actions',elements:[button('livo_kw_open',label('preview',s.source.locale),{pageId:item.pageId||item.id})]});else if(item.taskKey)blocks.push({type:'actions',elements:[{type:'button',text:{type:'plain_text',text:label('open',s.source.locale)},url:d.link({id:item.taskId||item.id,task_key:item.taskKey})}]});}
  if(!blocks.length)blocks.push(plain(label('empty',s.source.locale)));
  if(result.nextCursor!==null&&result.nextCursor!==undefined)blocks.push({type:'actions',elements:[button('livo_kw_next',label('next',s.source.locale),{cursor:result.nextCursor})]});
  return modal(blocks,meta(id,s));
}
export async function handleKnowledgeWork(p:Row,d:Actions,source:Row):Promise<Row|undefined>{
  if(!d.knowledgeWork)return;
  const slash=p.command?/^(docs|specs|drafts|meeting|weekly)(?:\s+(.*))?$/i.exec(String(p.text||'').trim()):null;
  const action=p.type==='block_actions'?p.actions?.[0]:null,submit=p.type==='view_submission'&&p.view?.callback_id==='livo_knowledge_work';
  const suggest=p.type==='block_suggestion'&&String(p.action_id||'').startsWith('livo_kw_');
  if(!slash&&!String(action?.action_id||'').startsWith('livo_kw_')&&!submit&&!suggest)return;
  if(suggest){try{
    if(!await d.enabled())return {options:[]};const actor=await d.actor(p);find(source,actor);
    if(p.action_id==='livo_kw_owner')return {options:await d.search(actor,'assignee',String(p.value||''))};
    const name=p.action_id,query=searchQuery(String(p.value||''),name==='livo_kw_predecessor',name==='livo_kw_predecessor'||name==='livo_kw_destination'?['knowledge']:KNOWLEDGE_SOURCE_KINDS);
    const result=await d.knowledgeWork.request(actor,'query',query),options:Row[]=[];
    for(const item of result.items||[]){const choice=item;if(name==='livo_kw_predecessor'&&(!item.publicationId||!Number.isSafeInteger(item.publicationVersion)))continue;
      const encoded=JSON.stringify(name==='livo_kw_predecessor'?{k:'predecessor',i:choice.publicationId,v:choice.publicationVersion}:name==='livo_kw_destination'?{k:'destination',i:item.pageId||item.id,p:item.projectId}:{k:item.kind,i:item.id,v:item.version});if(encoded.length<=150)options.push({text:{type:'plain_text',text:item.title.slice(0,75)},value:encoded});}
    return {options};
  }catch{return {options:[]};}}
  if(submit&&!['meeting','weekly'].includes(source.kwState?.mode||'')&&!state(p,'confirm').selected_options?.some((o:Row)=>o.value==='yes'))return {response_action:'errors',errors:{confirm:label('confirmNeeded',source.locale)}};
  const opening=submit?undefined:await d.slack(p.view?.id?'views.update':'views.open',p.view?.id?{view_id:p.view.id,view:notice('loading',source)}:{trigger_id:p.trigger_id,view:notice('loading',source)});
  d.background((async()=>{
    let view:Row,s:Session|undefined,id='';
    try{
      if(!await d.enabled())throw new KnowledgeWorkError('knowledge_forbidden',403);const actor=await d.actor(p);source={...source,locale:actor.locale};
      if(slash){const mode=slash[1].toLowerCase();[id,s]=create(actor,source,mode);if(mode==='meeting'||mode==='weekly')view=draftForm(id,s);else{s.query=mode==='drafts'?{operation:'drafts',cursor:0}:searchQuery(slash[2]||'',mode==='specs');view=await listing(id,s,actor,d);}}
      else if(action?.action_id==='livo_kw_open'){
        const v=JSON.parse(action.value||'{}');[id,s]=create(actor,source,'detail');s.page=await d.knowledgeWork.request(actor,'query',{operation:'detail',pageId:v.pageId});view=detailForm(id,s,d);
      }else{
        [id,s]=find(source,actor);source=meta(id,s);
        if(s.busy)return;
        if(submit||action?.action_id==='livo_kw_retry'){
          if(s.mode==='meeting'||s.mode==='weekly'){
            const selected=state(p,'livo_kw_sources').selected_options||[],refs=selected.map((o:Row)=>{const item=decodeChoice(o.value);if(!item)throw new KnowledgeWorkError('knowledge_conflict',409);return sourceRef(item);});
            s.input={kind:s.mode,notes:value(p,'notes')||'',...(value(p,'draftTitle')?{title:value(p,'draftTitle')}:{}),sourceRefs:refs,...(s.mode==='weekly'?{period:{from:state(p,'from').selected_date,to:state(p,'to').selected_date}}:{})};s.preview=await d.knowledgeWork.request(actor,'query',{operation:'prepare_draft',input:s.input});s.previewHash=await digest(s.preview);s.mode='preview';view=previewForm(id,s);
          }else{
            if(!s.command){let command:Row={commandId:s.commandId},page=s.page;
              if(s.mode==='preview'){const prior=await d.knowledgeWork.request(actor,'query',{operation:'command_result',commandId:s.commandId});if(prior.found===true){view=notice('saved',source);s.mode='done';await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view});return;}const fresh=await d.knowledgeWork.request(actor,'query',{operation:'prepare_draft',input:s.input});if(await digest(fresh)!==s.previewHash)throw new KnowledgeWorkError('knowledge_conflict',409);s.preview=fresh;command={...command,operation:'save_draft',preview:fresh,title:fresh.title,text:fresh.text,confirmed:true};}
              else{Object.assign(command,{pageId:page!.pageId,expectedVersion:page!.pageVersion});
                if(s.mode==='metadata')Object.assign(command,{operation:'set_metadata',metadata:{documentKind:state(p,'kind').selected_option?.value==='unknown'?null:state(p,'kind').selected_option?.value,ownerId:state(p,'livo_kw_owner').selected_option?.value||page!.metadata.ownerId,applicability:{productVersion:value(p,'productVersion'),environment:value(p,'environment'),summary:value(p,'summary')}}});
                else if(s.mode==='publish'||s.mode==='replace'){Object.assign(command,{operation:s.mode,expectedPublicationId:page!.publication?.id||null,confirmed:true});if(s.mode==='replace'){const prev=chosen(p,'livo_kw_predecessor',s);if(!prev)throw new KnowledgeWorkError('knowledge_conflict',409);Object.assign(command,{predecessorPublicationId:prev.publicationId,expectedPredecessorVersion:prev.publicationVersion});}}
                else if(s.mode==='link'||s.mode==='unlink'){const item=s.mode==='unlink'?s.query:chosen(p,'livo_kw_source',s);if(!item)throw new KnowledgeWorkError('knowledge_conflict',409);Object.assign(command,{operation:s.mode==='link'?'link_source':'unlink_source',source:sourceRef(item)});}
                else if(s.mode==='share'){const selected=state(p,'livo_kw_destination').selected_option,dest=chosen(p,'livo_kw_destination',s);if(selected&&!dest)throw new KnowledgeWorkError('knowledge_conflict',409);Object.assign(command,{operation:'share_draft',parentId:dest?.pageId||dest?.id||null,projectId:dest?.projectId||null,confirmed:true});}
              }s.command=parseKnowledgeWorkCommand(command);
            }
            s.busy=true;await d.knowledgeWork.request(actor,'command',s.command);view=notice('saved',source);s.mode='done';
          }
        }else if(action?.action_id==='livo_kw_next'){const v=JSON.parse(action.value||'{}');s.query={...s.query,cursor:v.cursor};view=await listing(id,s,actor,d);}
        else{
          const mode=String(action?.action_id||'').slice('livo_kw_'.length);if(!['metadata','publish','replace','link','unlink','share'].includes(mode)||!s.page)throw new KnowledgeWorkError('knowledge_invalid_input');
          const old=s,selected=JSON.parse(action.value||'{}');[id,s]=create(actor,old.source,mode);s.page=await d.knowledgeWork.request(actor,'query',{operation:'detail',pageId:old.page.pageId});if(mode==='unlink'){const ref=s.page.linkItems?.find((item:Row)=>item.kind===selected.kind&&item.id===selected.id);if(!ref)throw new KnowledgeWorkError('knowledge_source_unavailable',409);s.query={kind:ref.kind,id:ref.id,version:ref.version,title:ref.title};}view=editForm(id,s);
        }
      }
    }catch(error){const safe=knowledgeWorkError(error);let frozen:Row={locale:source.locale};try{frozen=id&&s?meta(id,s):frozen;}catch{}view=notice(safe.code,frozen,safe.status>=500&&!!s?.command&&!!frozen.kwState);}
    finally{if(s)s.busy=false;}
    await d.slack('views.update',{view_id:p.view?.id||opening?.view?.id,view:view!}).catch(()=>d.reply({...p,channel_id:source.channel,user_id:p.user?.id||p.user_id},label('unavailable',source.locale)).catch(()=>{}));
  })());
  return submit?{response_action:'update',view:notice('saving',source)}:{};
}
