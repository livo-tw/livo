import { useCallback, useEffect, useRef, useState } from 'react';
import { knowledgeImportRequest } from '@/lib/knowledgeImportClient';
import type { ImportCapability } from '@/types/knowledgeImport';
const empty:ImportCapability={allowed:false,can_manage:false,notion_available:false,processor_configured:false};
/** `identityKey` includes the current live member role/position, not only the auth session. */
export function useKnowledgeImportCapability(identityKey = '') {
  const [value,setValue]=useState(empty),[loading,setLoading]=useState(true),[error,setError]=useState('');const generation=useRef(0);
  const refresh=useCallback(async()=>{const n=++generation.current;setLoading(true);try{const next=await knowledgeImportRequest<ImportCapability>('capability');if(n===generation.current){setValue(next);setError('');}}catch(e){if(n===generation.current){setValue(empty);setError(e instanceof Error?e.message:'import_failed');}}finally{if(n===generation.current)setLoading(false);}},[]);
  useEffect(()=>{setValue(empty);void refresh();const focus=():void=>{void refresh();};window.addEventListener('focus',focus);const timer=window.setInterval(focus,30000);return()=>{generation.current++;window.removeEventListener('focus',focus);clearInterval(timer);};},[identityKey,refresh]);
  return {...value,loading,error,refresh};
}
