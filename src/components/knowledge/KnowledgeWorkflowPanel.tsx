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
import {KnowledgeWorkTargetPicker} from './KnowledgeWorkTargetPicker';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {Plus} from 'lucide-react';

function SourceQaCreate({pageId,pageVersion,item,onDone,onCancel}:{pageId:string;pageVersion:number;item:KnowledgeChecklistItem|null;onDone:()=>void;onCancel:()=>void}){
  const {t}=useTranslation();
  const qa=useQa(),project=useContext(ProjectContext),[issueId]=useState(randomUUID),[commandId]=useState(randomUUID);
  const client=useMemo(()=>({...qa.client,create:async(...args:Parameters<typeof qa.client.create>)=>{
    if(USING_MOCK_BACKEND){const issue=await qa.client.create(...args);await knowledgeWorkflowRequest({action:'link',pageId,commandId,targetKind:'qa',targetId:issue.id,relation:'verification',...(item?{checklistId:item.id,expectedVersion:item.version}:{} )});return issue;}
    const result=await knowledgeWorkflowRequest<{targetId:string}>({action:'create_qa',pageId,commandId,expectedPageVersion:pageVersion,input:args[0],relation:'verification',...(item?{checklistId:item.id,expectedVersion:item.version}:{})});
    return (await qa.client.get(result.targetId,args[3])).issue;
  }}),[qa.client,pageId,pageVersion,item,commandId]);
  if(!qa.enabled)return <p className="flex flex-wrap items-center gap-2 text-sm">{t('kbWorkflow.qaDisabled')} <Button type="button" size="sm" variant="outline" onClick={onCancel}>{t('common.cancel')}</Button></p>;
  return <QaCreatePanel client={client} projects={project?.allProjects||[]} productLines={project?.productLines||[]} issueId={issueId} commandId={commandId} onCreated={onDone} onCancel={onCancel}/>;
}

export function KnowledgeWorkflowPanel({pageId,canEdit,category,pageProjectId}:{pageId:string;canEdit:boolean;category?:string|null;pageProjectId?:string|null}){
  const {t}=useTranslation(),workflow=useKnowledgeWorkflow(pageId),project=useContext(ProjectContext),tasks=useContext(TaskContext),members=useContext(MemberContext);
  const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[form,setForm]=useState<'link'|'task'|'qa'|null>(null),[item,setItem]=useState<KnowledgeChecklistItem|null>(null);
  const [title,setTitle]=useState(''),[projectId,setProjectId]=useState(''),[statusId,setStatusId]=useState(''),[assigneeId,setAssigneeId]=useState(''),[dueDate,setDueDate]=useState(''),[description,setDescription]=useState('');
  const [expanded,setExpanded]=useState<boolean|null>(null);
  const [preview,setPreview]=useState<KnowledgeSourceSnapshot|null>(null),retry=useRef<{hash:string;id:string}|null>(null),activePage=useRef(workflow.contextKey),requestEpoch=useRef(0),snapshotRequest=useRef(0);activePage.current=workflow.contextKey;
  // The same field look as the shared Input, for the selects in the task form.
  const fieldClass='mt-1 flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm';
  const data=workflow.data,groups=groupProjectsByLine(project?.productLines||[],project?.allProjects||[]);
  useEffect(()=>{requestEpoch.current++;setPreview(null);setForm(null);setItem(null);setMessage('');setBusy(false);retry.current=null;return()=>{requestEpoch.current++;};},[workflow.contextKey,canEdit]);
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
  const openSnapshot=async(id:string)=>{const context=workflow.contextKey,epoch=requestEpoch.current,ticket=++snapshotRequest.current;setPreview(null);try{const result=await knowledgeWorkflowRequest<KnowledgeSourceSnapshot>({action:'snapshot',pageId,snapshotId:id});if(ticket===snapshotRequest.current&&epoch===requestEpoch.current&&activePage.current===context)setPreview(result);}catch{if(ticket===snapshotRequest.current&&epoch===requestEpoch.current&&activePage.current===context)setMessage(t('kbWorkflow.unavailable'));}};
  const checklistFields=item?{checklistId:item.id,expectedVersion:item.version}:{};
  // A task made from a meeting note is a meeting action; from any other page, a reference.
  const taskRelation=category==='meeting'?'meeting':'reference';
  const openStatuses=(tasks?.statuses||[]).filter(s=>!s.isDone).sort((a,b)=>a.sortOrder-b.sortOrder);
  // Start with the page's own project (when it can still take tasks) and the first open status.
  const openTaskForm=()=>{const pageProject=project?.allProjects.find(p=>p.id===pageProjectId&&!p.isArchived);setProjectId(current=>current||pageProject?.id||'');setStatusId(current=>current&&openStatuses.some(s=>s.id===current)?current:openStatuses[0]?.id||'');setForm('task');};
  if(workflow.loading)return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if(!data)return <p role="status" className="text-sm text-muted-foreground">{t('kbWorkflow.unavailable')}</p>;
  // Readers of a page without to-dos or linked work see nothing here; for editors it stays one
  // collapsed line until there is something in it. The list refreshes itself, so there is no refresh button.
  const count=data.checklist.length+data.links.length;
  if(!canEdit&&!count&&!data.snapshots.length)return null;
  const open=expanded??(count>0||!!form);
  return <details open={open} onToggle={event=>setExpanded(event.currentTarget.open)} className="group rounded-xl border bg-card p-4" aria-label={t('kbWorkflow.heading')}>
    <summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-semibold [&::-webkit-details-marker]:hidden">
      <h2>{t('kbWorkflow.heading')}{count>0&&<span className="ml-1.5 text-sm font-normal text-muted-foreground">({count})</span>}</h2>
      <span aria-hidden="true" className="text-muted-foreground transition-transform group-open:rotate-180">⌄</span>
    </summary>
    <div className="mt-4 space-y-6">
    {message&&<p role="alert" className="text-sm text-destructive">{message}</p>}
    <KnowledgeChecklist items={data.checklist} canEdit={canEdit} busy={busy} onAdd={text=>run({action:'checklist_add',text}).then(()=>{})}
      onSet={(c,isDone)=>safeRun({action:'checklist_set',checklistId:c.id,expectedVersion:c.version,isDone})} onDelete={c=>safeRun({action:'checklist_delete',checklistId:c.id,expectedVersion:c.version})}
      onLink={c=>{setItem(c);setForm('link');setTitle(c.text);}}/>
    <KnowledgeWorkLinks links={data.links} canEdit={canEdit} busy={busy} onUnlink={linkId=>safeRun({action:'unlink',linkId})}/>
    {canEdit&&!form&&<Button size="sm" variant="outline" className="gap-1.5" onClick={()=>{setItem(null);setTitle('');setForm('link');}}><Plus size={14} aria-hidden="true"/>{t('kbWorkflow.addLink')}</Button>}
    {canEdit&&form==='link'&&<section className="space-y-3 rounded-lg border p-3"><h3 className="text-sm font-semibold">{t('kbWorkflow.findExisting')}</h3>
      <KnowledgeWorkTargetPicker pageId={pageId} disabled={busy} onPick={(kind,target)=>{void safeRun({action:'link',targetKind:kind,targetId:target.id,relation:'reference',...checklistFields});}}/>
      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-sm"><span className="text-muted-foreground">{t('kbWorkflow.orCreate')}</span>
        <Button size="sm" variant="outline" onClick={openTaskForm}>{t('kbWorkflow.createTask')}</Button><Button size="sm" variant="outline" onClick={()=>setForm('qa')}>{t('kbWorkflow.createBug')}</Button>
        <Button size="sm" variant="ghost" onClick={()=>{setForm(null);setItem(null);}}>{t('common.cancel')}</Button></div>
    </section>}
    {canEdit&&form==='task'&&<form className="space-y-3 rounded-lg border p-3" onSubmit={e=>{e.preventDefault();void safeRun({action:'create_task',expectedPageVersion:data.pageVersion,relation:taskRelation,...checklistFields,input:{title,projectId,statusId,assigneeId:assigneeId||null,dueDate:dueDate||null,description}});}}>
      <h3 className="text-sm font-semibold">{t('kbWorkflow.createTask')}</h3><p className="text-sm text-amber-700 dark:text-amber-300">{t('kbWorkflow.publishHint')}</p>
      <label className="block text-sm">{t('kbWorkflow.title')}<Input required maxLength={200} value={title} onChange={e=>setTitle(e.target.value)} className="mt-1"/></label>
      <label className="block text-sm">{t('kbWorkflow.project')}<SearchableSelect required value={projectId} onChange={e=>setProjectId(e.target.value)} className={fieldClass}><option value="">{t('kbWorkflow.choose')}</option><ProjectSelectOptions groups={groups}/></SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.status')}<SearchableSelect required value={statusId} onChange={e=>setStatusId(e.target.value)} className={fieldClass}><option value="">{t('kbWorkflow.choose')}</option>{openStatuses.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.assignee')}<SearchableSelect value={assigneeId} onChange={e=>setAssigneeId(e.target.value)} className={fieldClass}><option value="">{t('kbWorkflow.unassigned')}</option>{members?.users.filter(u=>u.isActive!==false).map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</SearchableSelect></label>
      <label className="block text-sm">{t('kbWorkflow.deadline')}<Input type="date" value={dueDate} onChange={e=>setDueDate(e.target.value)} className="mt-1 w-auto"/></label>
      <label className="block text-sm">{t('kbWorkflow.description')}<Textarea maxLength={20000} value={description} onChange={e=>setDescription(e.target.value)} className="mt-1"/></label>
      <div className="flex gap-2"><Button type="submit" size="sm" disabled={busy}>{t('kbWorkflow.confirmCreate')}</Button><Button type="button" size="sm" variant="ghost" disabled={busy} onClick={()=>setForm('link')}>{t('common.cancel')}</Button></div>
    </form>}
    {canEdit&&form==='qa'&&<div><p className="mb-3 text-sm text-amber-700 dark:text-amber-300">{t('kbWorkflow.publishHint')}</p><SourceQaCreate pageId={pageId} pageVersion={data.pageVersion} item={item} onDone={()=>{setForm(null);setItem(null);void workflow.refresh();}} onCancel={()=>setForm('link')}/></div>}
    {/* Saved automatically when a task or bug is created from this page; no manual copies. */}
    {data.snapshots.length>0&&<details className="rounded border p-3"><summary className="cursor-pointer text-sm font-medium">{t('kbWorkflow.sources')} ({data.snapshots.length})</summary><p className="my-3 text-xs text-muted-foreground">{t('kbWorkflow.sourceHint')}</p>
      <ul className="space-y-2">{data.snapshots.map(source=><li key={source.id}><button type="button" className="text-left text-sm text-primary underline" onClick={()=>{void openSnapshot(source.id);}}>{source.sourceTitle} · {new Date(source.createdAt).toLocaleString()}</button></li>)}</ul>
      {preview&&<article className={`${KNOWLEDGE_READING_STYLE} mt-3 rounded border p-3`} dangerouslySetInnerHTML={{__html:renderKnowledgeHtml(preview.body||'')}}/>}
    </details>}
    </div>
  </details>;
}
