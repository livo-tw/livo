import { SearchableSelect } from '@/components/ui/searchable-select';
import {useContext,useEffect,useMemo,useRef,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {ProjectContext} from '@/context/ProjectContext';
import {TaskContext} from '@/context/TaskContext';
import {MemberContext} from '@/context/MemberContext';
import {groupProjectsByLine} from '@/lib/projectGroups';
import {ProjectSelectOptions} from '@/components/project/ProjectOptions';
import {useKnowledgeWorkflow} from '@/hooks/useKnowledgeWorkflow';
import {knowledgeWorkflowRequest} from '@/lib/knowledgeWorkflowClient';
import {canonicalWorkflow,type KnowledgeChecklistItem,type KnowledgeSourceSnapshot} from '@/lib/knowledgeWorkflowDomain';
import {renderKnowledgeHtml} from '@/lib/knowledgeHtml';
import {randomUUID} from '@/lib/generateId';
import {useQa} from '@/hooks/useQa';
import QaCreatePanel from '@/components/qa/QaCreatePanel';
import {USING_MOCK_BACKEND} from '@/integrations/supabase/client';
import {KnowledgeChecklist} from './KnowledgeChecklist';
import {KnowledgeWorkLinks} from './KnowledgeWorkLinks';
import {KNOWLEDGE_READING_STYLE} from './KnowledgeReadingBody';

function SourceQaCreate({pageId,pageVersion,item,onDone,onCancel}:{pageId:string;pageVersion:number;item:KnowledgeChecklistItem|null;onDone:()=>void;onCancel:()=>void}){
  const {t}=useTranslation();
  const qa=useQa(),project=useContext(ProjectContext),[issueId]=useState(randomUUID),[commandId]=useState(randomUUID);
  const client=useMemo(()=>({...qa.client,create:async(...args:Parameters<typeof qa.client.create>)=>{
    if(USING_MOCK_BACKEND){const issue=await qa.client.create(...args);await knowledgeWorkflowRequest({action:'link',pageId,commandId,targetKind:'qa',targetId:issue.id,relation:'verification',...(item?{checklistId:item.id,expectedVersion:item.version}:{} )});return issue;}
    const result=await knowledgeWorkflowRequest<{targetId:string}>({action:'create_qa',pageId,commandId,expectedPageVersion:pageVersion,input:args[0],relation:'verification',...(item?{checklistId:item.id,expectedVersion:item.version}:{})});
    return (await qa.client.get(result.targetId,args[3])).issue;
  }}),[qa.client,pageId,pageVersion,item,commandId]);
  if(!qa.enabled)return <p className="text-sm">{t('kbWorkflow.qaDisabled')} <button onClick={onCancel}>{t('common.cancel')}</button></p>;
  return <QaCreatePanel client={client} projects={project?.allProjects||[]} productLines={project?.productLines||[]} issueId={issueId} commandId={commandId} onCreated={onDone} onCancel={onCancel}/>;
}

export function KnowledgeWorkflowPanel({pageId,canEdit}:{pageId:string;canEdit:boolean}){
  const {t}=useTranslation(),workflow=useKnowledgeWorkflow(pageId),project=useContext(ProjectContext),tasks=useContext(TaskContext),members=useContext(MemberContext);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[form,setForm]=useState<'link'|'task'|'qa'|null>(null),[item,setItem]=useState<KnowledgeChecklistItem|null>(null);
  const [query,setQuery]=useState(''),[kind,setKind]=useState<'task'|'qa'>('task'),[results,setResults]=useState<{id:string;title:string;key:string}[]>([]);
  const [title,setTitle]=useState(''),[projectId,setProjectId]=useState(''),[statusId,setStatusId]=useState(''),[assigneeId,setAssigneeId]=useState(''),[dueDate,setDueDate]=useState(''),[description,setDescription]=useState('');
  const [preview,setPreview]=useState<KnowledgeSourceSnapshot|null>(null),retry=useRef<{hash:string;id:string}|null>(null),activePage=useRef(workflow.contextKey),requestEpoch=useRef(0),snapshotRequest=useRef(0);activePage.current=workflow.contextKey;
  const data=workflow.data,groups=groupProjectsByLine(project?.productLines||[],project?.allProjects||[]);
  useEffect(()=>{requestEpoch.current++;setPreview(null);setResults([]);setForm(null);setItem(null);setMessage('');setBusy(false);retry.current=null;return()=>{requestEpoch.current++;};},[workflow.contextKey,canEdit]);
  useEffect(()=>{if(preview&&!data?.snapshots.some(s=>s.id===preview.id))setPreview(null);},[data,preview]);
  useEffect(()=>{const anchor=new URLSearchParams(window.location.search).get('anchor');if(anchor&&data){const element=document.getElementById(`kb-anchor-${anchor}`)||document.getElementById(`kb-work-${anchor}`);element?.scrollIntoView?.({block:'center'});}},[data,pageId]);
  const run=async(payload:Record<string,unknown>)=>{
    if(busy)return;const captured=workflow.contextKey;setBusy(true);setMessage('');const hash=canonicalWorkflow(payload);
    if(retry.current?.hash!==hash)retry.current={hash,id:randomUUID()};
    try{await workflow.mutate(payload,retry.current.id);retry.current=null;if(activePage.current===captured){setForm(null);setItem(null);}await tasks?.refreshTasks();}
    catch(e){if(activePage.current===captured)setMessage(t(`kbWorkflow.errors.${e instanceof Error?e.message:'kb_workflow_unavailable'}`,{defaultValue:t('kbWorkflow.failed')}));throw e;}
    finally{if(activePage.current===captured)setBusy(false);}
  };
  const safeRun=async(payload:Record<string,unknown>)=>{try{await run(payload);}catch{/* visible retry message, keep current persisted state */}};
  const search=async()=>{const context=workflow.contextKey,epoch=++requestEpoch.current;setBusy(true);setMessage('');try{const result=await knowledgeWorkflowRequest<{items:typeof results}>({action:'search_targets',pageId,targetKind:kind,query});if(epoch===requestEpoch.current&&activePage.current===context)setResults(result.items);}catch{if(epoch===requestEpoch.current&&activePage.current===context)setMessage(t('kbWorkflow.failed'));}finally{if(epoch===requestEpoch.current&&activePage.current===context)setBusy(false);}};
  const openSnapshot=async(id:string)=>{const context=workflow.contextKey,epoch=requestEpoch.current,ticket=++snapshotRequest.current;setPreview(null);try{const result=await knowledgeWorkflowRequest<KnowledgeSourceSnapshot>({action:'snapshot',pageId,snapshotId:id});if(ticket===snapshotRequest.current&&epoch===requestEpoch.current&&activePage.current===context)setPreview(result);}catch{if(ticket===snapshotRequest.current&&epoch===requestEpoch.current&&activePage.current===context)setMessage(t('kbWorkflow.unavailable'));}};
  const checklistFields=item?{checklistId:item.id,expectedVersion:item.version}:{};
  if(workflow.loading)return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if(!data)return <p role="status" className="text-sm text-muted-foreground">{t('kbWorkflow.unavailable')}</p>;
  return <aside className="space-y-6 rounded-xl border bg-card p-4" aria-label={t('kbWorkflow.heading')}>
    <div className="flex items-center justify-between"><h2 className="font-semibold">{t('kbWorkflow.heading')}</h2><button className="text-xs text-primary" onClick={()=>{void workflow.refresh();}}>{t('kbWorkflow.refresh')}</button></div>
    {message&&<p role="alert" className="text-sm text-destructive">{message}</p>}
    <KnowledgeChecklist items={data.checklist} canEdit={canEdit} busy={busy} onAdd={text=>run({action:'checklist_add',text}).then(()=>{})}
      onSet={(c,isDone)=>safeRun({action:'checklist_set',checklistId:c.id,expectedVersion:c.version,isDone})} onDelete={c=>safeRun({action:'checklist_delete',checklistId:c.id,expectedVersion:c.version})}
      onLink={c=>{setItem(c);setForm('link');setTitle(c.text);setResults([]);}}/>
    <KnowledgeWorkLinks links={data.links} canEdit={canEdit} busy={busy} onUnlink={linkId=>safeRun({action:'unlink',linkId})}/>
    {canEdit&&!form&&<button className="text-sm text-primary underline" onClick={()=>{setItem(null);setTitle('');setForm('link');setResults([]);}}>{t('kbWorkflow.addLink')}</button>}
    {canEdit&&form==='link'&&<section className="space-y-3 rounded border p-3"><h3 className="text-sm font-semibold">{t('kbWorkflow.findExisting')}</h3>
      <form className="flex flex-wrap gap-2" onSubmit={e=>{e.preventDefault();void search();}}>
        <SearchableSelect disabled={busy} aria-label={t('kbWorkflow.targetType')} value={kind} onChange={e=>{setKind(e.target.value as 'task'|'qa');setResults([]);}} className="rounded border bg-background p-2"><option value="task">{t('kbWorkflow.task')}</option><option value="qa">{t('kbWorkflow.bug')}</option></SearchableSelect>
        <input aria-label={t('kbWorkflow.search')} value={query} maxLength={200} onChange={e=>setQuery(e.target.value)} className="min-w-0 flex-1 rounded border bg-background p-2"/><button disabled={busy} type="submit">{t('kbWorkflow.search')}</button></form>
      <ul>{results.map(result=><li key={result.id}><button disabled={busy} className="py-2 text-left text-sm text-primary underline" onClick={()=>{void safeRun({action:'link',targetKind:kind,targetId:result.id,relation:'reference',...checklistFields});}}>{result.key} · {result.title}</button></li>)}</ul>
      <div className="flex flex-wrap gap-3 text-sm"><button onClick={()=>setForm('task')}>{t('kbWorkflow.createTask')}</button><button onClick={()=>setForm('qa')}>{t('kbWorkflow.createBug')}</button><button onClick={()=>{setForm(null);setItem(null);}}>{t('common.cancel')}</button></div>
    </section>}
    {canEdit&&form==='task'&&<form className="space-y-3 rounded border p-3" onSubmit={e=>{e.preventDefault();void safeRun({action:'create_task',expectedPageVersion:data.pageVersion,relation:'meeting',...checklistFields,input:{title,projectId,statusId,assigneeId:assigneeId||null,dueDate:dueDate||null,description}});}}>
      <h3 className="font-semibold">{t('kbWorkflow.createTask')}</h3><p className="text-sm text-amber-700 dark:text-amber-300">{t('kbWorkflow.publishHint')}</p>
      <label className="block text-sm">{t('kbWorkflow.title')}<input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} className="mt-1 block w-full rounded border bg-background p-2"/></label>
      <label className="block text-sm">{t('kbWorkflow.project')}<SearchableSelect required value={projectId} onChange={e=>setProjectId(e.target.value)} className="mt-1 block w-full rounded border bg-background p-2"><option value="">{t('kbWorkflow.choose')}</option><ProjectSelectOptions groups={groups}/></SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.status')}<SearchableSelect required value={statusId} onChange={e=>setStatusId(e.target.value)} className="mt-1 block w-full rounded border bg-background p-2"><option value="">{t('kbWorkflow.choose')}</option>{tasks?.statuses.filter(s=>!s.isDone).map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.assignee')}<SearchableSelect value={assigneeId} onChange={e=>setAssigneeId(e.target.value)} className="mt-1 block w-full rounded border bg-background p-2"><option value="">{t('kbWorkflow.unassigned')}</option>{members?.users.filter(u=>u.isActive!==false).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.deadline')}<input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} className="ml-2 rounded border bg-background p-2"/></label>
      <label className="block text-sm">{t('kbWorkflow.description')}<textarea maxLength={20000} value={description} onChange={e=>setDescription(e.target.value)} className="mt-1 block w-full rounded border bg-background p-2"/></label>
      <div className="flex gap-3 text-sm"><button type="submit" disabled={busy} className="rounded bg-primary px-3 py-2 text-primary-foreground">{t('kbWorkflow.confirmCreate')}</button><button type="button" disabled={busy} onClick={()=>setForm('link')}>{t('common.cancel')}</button></div>
    </form>}
    {canEdit&&form==='qa'&&<div><p className="mb-3 text-sm text-amber-700 dark:text-amber-300">{t('kbWorkflow.publishHint')}</p><SourceQaCreate pageId={pageId} pageVersion={data.pageVersion} item={item} onDone={()=>{setForm(null);setItem(null);void workflow.refresh();}} onCancel={()=>setForm('link')}/></div>}
    <details className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t('kbWorkflow.sources')}</summary><p className="my-3 text-xs text-muted-foreground">{t('kbWorkflow.sourceHint')}</p>
      {canEdit&&<button disabled={busy} className="mb-2 text-sm text-primary underline" onClick={()=>{void safeRun({action:'capture_snapshot',expectedPageVersion:data.pageVersion});}}>{t('kbWorkflow.capture')}</button>}
      <ul className="space-y-2">{data.snapshots.map(source=><li key={source.id}><button className="text-left text-sm text-primary underline" onClick={()=>{void openSnapshot(source.id);}}>{source.sourceTitle} · {new Date(source.createdAt).toLocaleString()}</button></li>)}</ul>
      {preview&&<article className={`${KNOWLEDGE_READING_STYLE} mt-3 rounded border p-3`} dangerouslySetInnerHTML={{__html:renderKnowledgeHtml(preview.body||'')}}/>}
    </details>
  </aside>;
}
