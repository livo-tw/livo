import {useTranslation} from 'react-i18next';
import {useContext} from 'react';
import {MemberContext} from '@/context/MemberContext';
import type {KnowledgeWorkLink} from '@/lib/knowledgeWorkflowDomain';
import {qaShortId} from '@/lib/qa/shortId';
import {Button} from '@/components/ui/button';
export function knowledgeWorkUrl(kind:'task'|'qa',id:string){return `${import.meta.env.BASE_URL}?${kind}=${encodeURIComponent(id)}`;}
export function KnowledgeWorkLinks({links,canEdit,busy,onUnlink}:{links:KnowledgeWorkLink[];canEdit:boolean;busy:boolean;onUnlink:(id:string)=>Promise<void>}){
  const {t}=useTranslation(),members=useContext(MemberContext);return <section className="space-y-3" aria-label={t('kbWorkflow.links')}><h3 className="font-semibold">{t('kbWorkflow.links')}</h3>
    {!links.length&&<p className="text-sm text-muted-foreground">{t('kbWorkflow.noLinks')}</p>}
    <ul className="space-y-2">{links.map(link=><li key={link.id} id={`kb-work-${link.anchorId}`} className="rounded border bg-card p-3">
      <div className="flex items-start justify-between gap-2">{link.unavailable?<span className="text-sm text-muted-foreground">{t('kbWorkflow.targetUnavailable')}</span>:<a href={knowledgeWorkUrl(link.targetKind,link.targetId)} className="text-sm font-medium text-primary underline">{link.targetKind==='qa'?qaShortId(link.targetId):link.key} · {link.title}</a>}
        {canEdit&&<Button type="button" size="sm" variant="ghost" className="h-8 shrink-0 px-2 text-xs text-muted-foreground" disabled={busy} onClick={()=>{void onUnlink(link.id);}}>{t('kbWorkflow.unlink')}</Button>}</div>
      {!link.unavailable&&<div className="mt-2 flex flex-wrap gap-2 text-xs"><span className="rounded bg-secondary px-2 py-1">{link.targetKind==='qa'?t(`qa.state.${link.status}`,{defaultValue:link.status}):link.status}</span><span>{t(`kbWorkflow.relation.${link.relation}`)}</span><span>{members?.users.find(u=>u.id===link.assigneeId)?.name||t('kbWorkflow.unassigned')}</span>{link.dueDate&&<span>{t('kbWorkflow.due',{date:link.dueDate})}</span>}</div>}
    </li>)}</ul><p className="text-xs text-muted-foreground">{t('kbWorkflow.liveHint')}</p></section>;
}
