import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { User } from '@/types';
import type { KnowledgeRule } from '@/types/knowledge';
import type { ImportPolicy } from '@/types/knowledgeImport';
import { knowledgeImportRequest } from '@/lib/knowledgeImportClient';
import { useKnowledgeImportText } from '@/hooks/useKnowledgeImportText';
import { Button } from '@/components/ui/button';

export function ImportSubjectSelector({value,onChange,users,disabled=false}:{value:KnowledgeRule;onChange:(rule:KnowledgeRule)=>void;users:User[];disabled?:boolean}) {
  const text=useKnowledgeImportText(),{t}=useTranslation();
  const active=users.filter(u=>u.isActive!==false),positions=[...new Set([...active.map(u=>u.jobTitle).filter(Boolean),...value.positions])].sort();
  const toggle=(field:keyof KnowledgeRule,item:string)=>onChange({...value,[field]:value[field].includes(item)?value[field].filter(x=>x!==item):[...value[field],item]});
  return <fieldset disabled={disabled} className="grid gap-4 sm:grid-cols-3">
    {(['roles','positions','member_ids'] as const).map(field=><fieldset key={field}><legend className="text-sm font-medium">{text(field==='member_ids'?'members':field)}</legend><div className="max-h-52 overflow-auto">
      {(field==='roles'?['member','admin','super_admin']:field==='positions'?positions:active.map(u=>u.id)).map(item=><label className="flex min-h-11 gap-2 items-center text-sm" key={item}><input type="checkbox" checked={value[field].includes(item)} onChange={()=>toggle(field,item)}/>{field==='roles'?t(`kb.permissions.role.${item}`):field==='member_ids'?active.find(u=>u.id===item)?.name:item}</label>)}
    </div></fieldset>)}
  </fieldset>;
}

type SafePolicy=Omit<ImportPolicy,'notion_secret'>&{notion_configured:boolean};
export default function KnowledgeImportPermissions({actor,users}:{actor:User;users:User[]}) {
  const text=useKnowledgeImportText(),[policy,setPolicy]=useState<SafePolicy|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[token,setToken]=useState(''),[pages,setPages]=useState(''),[disconnect,setDisconnect]=useState(false);const generation=useRef(0);
  const reload=async()=>{const current=++generation.current;setPolicy(null);setToken('');setError('');setBusy(true);try{const next=await knowledgeImportRequest<SafePolicy>('policy');if(current===generation.current){setPolicy(next);setPages(next.notion_pages.join('\n'));}}catch(e){if(current===generation.current)setError(e instanceof Error?e.message:'import_failed');}finally{if(current===generation.current)setBusy(false);}};
  useEffect(()=>{const current=++generation.current;setPolicy(null);setToken('');setError('');if(actor.role==='super_admin'&&actor.isActive!==false)void knowledgeImportRequest<SafePolicy>('policy').then(value=>{if(current===generation.current){setPolicy(value);setPages(value.notion_pages.join('\n'));}}).catch(()=>{if(current===generation.current)setError('import_failed');});return()=>{generation.current++;};},[actor.id,actor.role,actor.isActive]);
  if(actor.role!=='super_admin')return <p className="text-sm text-muted-foreground">{text('onlySuper')}</p>;
  const save=async()=>{if(!policy)return;setBusy(true);setError('');setSaved(false);try{const result=await knowledgeImportRequest<SafePolicy>('save_policy',{...policy,notion_pages:pages.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),notion_token:token,disconnect_notion:disconnect});setPolicy(result);setToken('');setDisconnect(false);setSaved(true);}catch(e){const message=e instanceof Error?e.message:'import_failed';setError(message);setToken('');if(/forbidden|unauthorized/.test(message))setPolicy(null);}finally{setBusy(false);}};
  return <section className="space-y-4 rounded-lg border p-4" aria-label={text('permissionTitle')}><h3 className="font-semibold">{text('permissionTitle')}</h3><p className="text-sm text-muted-foreground">{text('capabilityHelp')}</p>
    {error&&<p role="alert" className="text-sm text-destructive">{text(error)}</p>}{saved&&<p role="status" className="text-sm text-emerald-700">{text('saved')}</p>}
    {!policy?(error?<Button variant="outline" className="min-h-11" disabled={busy} onClick={()=>void reload()}>{text('reload')}</Button>:<p role="status">{text('busy')}</p>):<>
      <ImportSubjectSelector value={policy.subjects} onChange={subjects=>setPolicy({...policy,subjects})} users={users} disabled={busy}/>
      <details className="rounded border p-3"><summary className="cursor-pointer min-h-11 py-2 font-medium">{text('notionConnection')}</summary><div className="space-y-4 pt-2"><p className="text-sm text-muted-foreground">{text('notionHelp')}</p>{policy.notion_configured&&<p className="text-sm">{text('connected')}</p>}
        <label className="block text-sm">{text('notionToken')}<input type="password" autoComplete="new-password" className="block mt-1 w-full rounded border bg-background p-3" value={token} onChange={e=>setToken(e.target.value)} disabled={busy}/></label>
        <label className="block text-sm">{text('notionPages')}<textarea className="block mt-1 w-full rounded border bg-background p-3" rows={3} value={pages} onChange={e=>setPages(e.target.value)} disabled={busy}/></label>
        <h4 className="font-medium text-sm">{text('notionUsers')}</h4><ImportSubjectSelector value={policy.notion_subjects} onChange={notion_subjects=>setPolicy({...policy,notion_subjects})} users={users} disabled={busy}/>
        {policy.notion_configured&&<label className="flex min-h-11 gap-2 items-center text-sm"><input type="checkbox" checked={disconnect} onChange={e=>setDisconnect(e.target.checked)} disabled={busy}/>{text('disconnect')}</label>}
      </div></details>
      <Button className="min-h-11" disabled={busy} onClick={()=>void save()}>{text(busy?'busy':'save')}</Button>
    </>}
  </section>;
}
