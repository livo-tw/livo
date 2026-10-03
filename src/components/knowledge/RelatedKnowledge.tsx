import {useContext,useEffect,useState} from 'react';
import {useTranslation} from 'react-i18next';
import {AuthContext} from '@/context/AuthContext';
import {knowledgeWorkflowRequest} from '@/lib/knowledgeWorkflowClient';
import type {KnowledgeTargetKind,RelatedKnowledgePage} from '@/lib/knowledgeWorkflowDomain';
export function RelatedKnowledge({targetKind,targetId}:{targetKind:KnowledgeTargetKind;targetId:string}){
  const {t}=useTranslation(),currentMember=useContext(AuthContext)?.currentMember,[items,setItems]=useState<RelatedKnowledgePage[]>([]);
  const identity=`${targetKind}|${targetId}|${currentMember?.id}|${currentMember?.role}|${currentMember?.jobTitle}`,[loadedIdentity,setLoadedIdentity]=useState('');
  useEffect(()=>{let active=true,request=0;setItems([]);if(!currentMember?.id)return;const load=async()=>{const token=++request;try{const result=await knowledgeWorkflowRequest<{items:RelatedKnowledgePage[]}>({action:'backlinks',targetKind,targetId});if(active&&request===token){setItems(result.items);setLoadedIdentity(identity);}}catch{if(active&&request===token)setItems([]);}};void load();window.addEventListener('focus',load);const timer=window.setInterval(load,20000);return()=>{active=false;window.removeEventListener('focus',load);window.clearInterval(timer);};},[targetKind,targetId,currentMember?.id,identity]);
  if(!currentMember?.id||loadedIdentity!==identity||!items.length)return null;
  return <section className="space-y-2 rounded border p-3" aria-label={t('kbWorkflow.relatedKnowledge')}><h3 className="text-sm font-semibold">{t('kbWorkflow.relatedKnowledge')}</h3>
    <ul className="space-y-2">{items.map(item=><li key={item.linkId}><a className="text-sm text-primary underline" href={`${import.meta.env.BASE_URL}?kb=${encodeURIComponent(item.pageId)}&anchor=${encodeURIComponent(item.anchorId)}`}>{item.title}</a><span className="ml-2 text-xs text-muted-foreground">{t(`kbWorkflow.relation.${item.relation}`)}</span></li>)}</ul></section>;
}
export default RelatedKnowledge;
