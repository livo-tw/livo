import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthContext } from '@/context/AuthContext';
import { knowledgeWorkflowRequest } from '@/lib/knowledgeWorkflowClient';
import type { KnowledgeWorkflowData } from '@/lib/knowledgeWorkflowDomain';
import { randomUUID } from '@/lib/generateId';

export function useKnowledgeWorkflow(pageId: string) {
  const {currentMember}=useAuthContext();
  const identity=`${currentMember?.id}|${currentMember?.role}|${currentMember?.jobTitle}`;
  const contextKey=`${pageId}|${identity}`;
  const [data,setData]=useState<KnowledgeWorkflowData|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState<string|null>(null);
  const [dataKey,setDataKey]=useState('');
  const generation=useRef(0),latest=useRef({pageId,identity});latest.current={pageId,identity};
  const refresh=useCallback(async()=>{
    const token=++generation.current,captured={pageId,identity};
    try{
      const next=await knowledgeWorkflowRequest<KnowledgeWorkflowData>({action:'list',pageId});
      if(token===generation.current&&latest.current.pageId===captured.pageId&&latest.current.identity===captured.identity){setData(next);setDataKey(`${captured.pageId}|${captured.identity}`);setError(null);}
    }catch(e){if(token===generation.current&&latest.current.pageId===captured.pageId&&latest.current.identity===captured.identity){setData(null);setError(e instanceof Error?e.message:'kb_workflow_unavailable');}}
    finally{if(token===generation.current)setLoading(false);}
  },[pageId,identity]);
  useEffect(()=>{setData(null);setLoading(true);void refresh();const focus=()=>{void refresh();};window.addEventListener('focus',focus);const timer=window.setInterval(focus,20000);return()=>{generation.current++;window.removeEventListener('focus',focus);window.clearInterval(timer);};},[refresh]);
  const mutate=useCallback(async(payload:Record<string,unknown>,commandId=randomUUID())=>{
    try{return await knowledgeWorkflowRequest<Record<string,unknown>>({...payload,pageId,commandId});}
    finally{if(latest.current.pageId===pageId&&latest.current.identity===identity)await refresh();}
  },[pageId,identity,refresh]);
  return {data:dataKey===contextKey?data:null,loading,error,refresh,mutate,contextKey};
}
