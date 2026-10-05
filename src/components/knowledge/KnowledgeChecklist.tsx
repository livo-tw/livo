import { useContext, useState } from 'react';
import {MemberContext} from '@/context/MemberContext';
import { useTranslation } from 'react-i18next';
import type { KnowledgeChecklistItem } from '@/lib/knowledgeWorkflowDomain';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function KnowledgeChecklist({items,canEdit,busy,onAdd,onSet,onDelete,onLink}:{items:KnowledgeChecklistItem[];canEdit:boolean;busy:boolean;
  onAdd:(text:string)=>Promise<void>;onSet:(item:KnowledgeChecklistItem,done:boolean)=>Promise<void>;onDelete:(item:KnowledgeChecklistItem)=>Promise<void>;onLink:(item:KnowledgeChecklistItem)=>void}){
  const {t}=useTranslation(),[text,setText]=useState(''),members=useContext(MemberContext);
  return <section aria-label={t('kbWorkflow.checklist')} className="space-y-3">
    <h3 className="font-semibold">{t('kbWorkflow.checklist')}</h3><p className="text-sm text-muted-foreground">{t('kbWorkflow.checklistHint')}</p>
    <ul className="space-y-2">{items.map(item=><li key={item.id} id={`kb-anchor-${item.anchorId}`} className="flex items-start gap-2 rounded border p-2">
      {item.linkedWorkId?<span className="rounded bg-primary/10 px-2 py-1 text-xs text-primary">{t('kbWorkflow.linked')}</span>:
        <input type="checkbox" aria-label={item.text} checked={item.isDone} disabled={!canEdit||busy} onChange={e=>{void onSet(item,e.target.checked);}} className="mt-1"/>}
      <div className="min-w-0 flex-1"><span className={item.isDone&&!item.linkedWorkId?'line-through text-muted-foreground':''}>{item.text}</span>
        {item.completedAt&&!item.linkedWorkId&&<p className="text-xs text-muted-foreground">{members?.users.find(u=>u.id===item.completedBy)?.name} · {t('kbWorkflow.completedAt',{date:new Date(item.completedAt).toLocaleString()})}</p>}</div>
      {canEdit&&!item.linkedWorkId&&<div className="flex shrink-0 gap-1"><Button type="button" size="sm" variant="outline" className="h-8 px-2 text-xs" disabled={busy} onClick={()=>onLink(item)}>{t('kbWorkflow.track')}</Button><Button type="button" size="sm" variant="ghost" className="h-8 px-2 text-xs text-muted-foreground" disabled={busy} onClick={()=>{void onDelete(item);}}>{t('common.delete')}</Button></div>}
    </li>)}</ul>
    {canEdit&&<form className="flex gap-2" onSubmit={e=>{e.preventDefault();if(text.trim())void onAdd(text.trim()).then(()=>setText('')).catch(()=>{});}}>
      <Input aria-label={t('kbWorkflow.newChecklist')} maxLength={2000} className="min-w-0 flex-1" value={text} onChange={e=>setText(e.target.value)} placeholder={t('kbWorkflow.newChecklist')}/>
      <Button type="submit" disabled={busy||!text.trim()}>{t('common.add')}</Button>
    </form>}
  </section>;
}
