import { useEffect,useRef,useState } from 'react';
import { knowledgeImportRequest,downloadImportSource } from '@/lib/knowledgeImportClient';
import { useKnowledgeImportText } from '@/hooks/useKnowledgeImportText';
import { Button } from '@/components/ui/button';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';
import { useAuthContext } from '@/context/AuthContext';
import { useMemberContext } from '@/context/MemberContext';
import { KNOWLEDGE_READING_STYLE } from '@/components/knowledge/KnowledgeReadingBody';
type Source={id:string;version:number;body:string;original:{name:string};assets:{name:string}[]};
const forbidden=(failure:unknown)=>failure instanceof Error&&['import_forbidden','kb_forbidden','forbidden'].includes(failure.message);
export default function KnowledgeImportSources({pageId}:{pageId:string}) {
  const text=useKnowledgeImportText(),[sources,setSources]=useState<Source[]>([]),[error,setError]=useState('');const generation=useRef(0);
  const {currentMemberId,currentMember}=useAuthContext(),{users}=useMemberContext();const actor=users.find(u=>u.id===currentMemberId)||currentMember;
  const identity=[actor?.id,actor?.role,actor?.jobTitle,actor?.isActive].join('|');
  useEffect(()=>{let active=true;setSources([]);setError('');const refresh=()=>{const current=++generation.current;void knowledgeImportRequest<Source[]>('sources',{page_id:pageId}).then(rows=>{if(active&&current===generation.current){setSources(rows);setError('');}}).catch(failure=>{if(active&&current===generation.current){
    // Only a refusal means this person may no longer see the sources; anything else (offline, the
    // import service not set up) keeps what is shown and stays quiet, as this section is supplementary.
    if(forbidden(failure)){setSources([]);setError('import_forbidden');}}});};refresh();window.addEventListener('focus',refresh);const timer=setInterval(refresh,30000);return()=>{active=false;generation.current++;clearInterval(timer);window.removeEventListener('focus',refresh);};},[pageId,identity]);
  const download=async(source:Source,index?:number)=>{try{await downloadImportSource(pageId,source.id,index);setError('');}catch(failure){if(forbidden(failure)){setSources([]);setError('import_forbidden');}else setError('import_interrupted');}};
  if(!sources.length)return error?<p role="alert" className="text-sm text-muted-foreground">{text(error)}</p>:null;
  return <section className="space-y-2 border-t pt-4"><h3 className="font-semibold text-sm">{text('sourceVersions')}</h3>{error&&<p role="alert" className="text-sm text-destructive">{text(error)}</p>}{sources.map(source=><details key={source.id} className="rounded border p-3"><summary className="cursor-pointer min-h-11 py-2">v{source.version} · {source.original.name}</summary><div className="flex flex-wrap gap-2"><Button variant="outline" className="min-h-11" onClick={()=>void download(source)}>{text('download')}</Button>{source.assets.map((asset,index)=><Button variant="outline" className="min-h-11" key={index} onClick={()=>void download(source,index)}>{asset.name}</Button>)}</div><div className={KNOWLEDGE_READING_STYLE+' mt-4'} dangerouslySetInnerHTML={{__html:renderKnowledgeHtml(source.body)}}/></details>)}</section>;
}
