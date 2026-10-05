import { supabase } from '@/integrations/supabase/client';
export async function knowledgeImportRequest<T>(action: string, values: Record<string,unknown> = {}): Promise<T> {
  const {data,error}=await supabase.functions.invoke('knowledge-import',{body:{action,...values}});
  if(error){
    let message=(error as {code?:string}).code||error.message;const context=(error as {context?:Response}).context;
    if(context instanceof Response){let code='';try{const payload=await context.json();if(typeof payload.error==='string')code=payload.error;else if(typeof payload.error?.code==='string')code=payload.error.code;}catch{/* Transport errors contain no document content. */}
      // The Edge Runtime answers { msg } when it stops the worker (for example over its
      // memory limit), and a proxy may answer without JSON: both mean the server gave up.
      message=code||(context.status>=500?'import_interrupted':message);}
    else if((error as {name?:string}).name==='FunctionsFetchError')message='import_interrupted';
    throw new Error(message||'import_failed');
  }
  if(data&&typeof data==='object'){const problem=(data as {error?:string|{code?:string;message?:string}}).error;if(problem)throw new Error(typeof problem==='string'?problem:problem.code||problem.message||'import_failed');}
  return data as T;
}
export async function fileBase64(file: File): Promise<string> {
  if(!file.size||file.size>10*1024*1024)throw new Error('file_size_limit');
  const bytes=new Uint8Array(await file.arrayBuffer());let text='';for(let i=0;i<bytes.length;i+=8192)text+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(text);
}
export async function downloadImportSource(pageId:string,sourceId:string,assetIndex?:number) {
  const file=await knowledgeImportRequest<{name:string;type:string;data:string}>('download_source',{page_id:pageId,source_id:sourceId,...(assetIndex===undefined?{}:{asset_index:assetIndex})});
  downloadFile(file);
}
export async function downloadImportPreview(jobId:string,itemId:string) {
  downloadFile(await knowledgeImportRequest<{name:string;type:string;data:string}>('download_preview',{job_id:jobId,item_id:itemId}));
}
function downloadFile(file:{name:string;type:string;data:string}) {
  const binary=atob(file.data),bytes=new Uint8Array(binary.length);for(let i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
  const url=URL.createObjectURL(new Blob([bytes],{type:file.type}));const link=document.createElement('a');link.href=url;link.download=file.name;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
