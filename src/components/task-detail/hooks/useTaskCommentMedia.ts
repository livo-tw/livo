import { useEffect, useRef, useState } from 'react';
import { randomUUID } from '@/lib/generateId';
import { COMMENT_FILE_COUNT, CommentAttachmentError, commentFileError, type CommentMedia } from '@/lib/taskCommentAttachmentCore';
import { taskCommentClient, uploadTaskCommentFile, type TaskCommentResume, type TaskCommentReceipt } from '@/lib/taskCommentClient';

export type TaskCommentDraftFile = { id:string;file:File;preview?:string;progress:number;status:'pending'|'uploading'|'complete'|'failed';resume:TaskCommentResume };
type Rejected={name:string;code:'file_size'|'file_type'|'file_name'};
type PublishInput={taskId:string;commandId:string;body:string;uploadIds:string[];mentionIds:string[]};
const revoke=(file:TaskCommentDraftFile)=>{if(file.preview)URL.revokeObjectURL(file.preview);};
export function useTaskCommentMedia(taskId:string|undefined,actorId:string,onError:(error:unknown)=>void){
  const [files,setFiles]=useState<TaskCommentDraftFile[]>([]),[rejected,setRejected]=useState<Rejected[]>([]),[busy,setBusy]=useState(false),[attachments,setAttachments]=useState<CommentMedia[]>([]),[pending,setPending]=useState(false);
  const current=useRef<TaskCommentDraftFile[]>([]),generation=useRef(0),running=useRef(false),controller=useRef<AbortController>(),readController=useRef<AbortController>(),command=useRef<PublishInput>();
  const commandOutcomeUnknown=useRef(false);
  const listVersion=useRef(0);
  const errorCallback=useRef(onError);errorCallback.current=onError;
  const update=(id:string,patch:Partial<TaskCommentDraftFile>)=>{current.current=current.current.map(file=>file.id===id?{...file,...patch}:file);setFiles(current.current);};
  const refresh=async(signal?:AbortSignal)=>{
    if(!taskId)return;const key=generation.current,version=++listVersion.current;
    const result=await taskCommentClient.list(taskId,signal);
    if(key===generation.current&&version===listVersion.current&&!signal?.aborted)setAttachments(result.attachments);
  };
  useEffect(()=>{
    const key=++generation.current;current.current.forEach(revoke);current.current=[];setFiles([]);setRejected([]);setAttachments([]);command.current=undefined;commandOutcomeUnknown.current=false;setPending(false);running.current=false;setBusy(false);
    const read=new AbortController();readController.current=read;
    const version=++listVersion.current;
    if(taskId)void taskCommentClient.list(taskId,read.signal).then(result=>{if(key===generation.current&&version===listVersion.current&&!read.signal.aborted)setAttachments(result.attachments);}).catch(error=>{if(!read.signal.aborted)errorCallback.current(error);});
    return()=>{generation.current++;read.abort();controller.current?.abort();current.current.forEach(revoke);};
  },[taskId,actorId]);
  const upload=async(signal:AbortSignal)=>{
    if(!taskId)throw new CommentAttachmentError('task_unavailable');const key=generation.current;
    for(const entry of current.current){
      if(entry.resume.attachment)continue;update(entry.id,{status:'uploading'});
      try{
        await uploadTaskCommentFile(taskId,entry.file,entry.resume,value=>{if(key===generation.current&&!signal.aborted)update(entry.id,{progress:value});},signal);
        if(key!==generation.current||signal.aborted)throw new DOMException('Aborted','AbortError');update(entry.id,{status:'complete',progress:100});
      }catch(error){if(key===generation.current)update(entry.id,{status:signal.aborted?'pending':'failed'});throw error;}
    }
  };
  return {
    files,rejected,busy,pending,attachments,refresh,scopeKey:`${actorId}:${taskId||''}`,
    add(incoming:File[]){
      if(running.current||command.current)return;const failures:Rejected[]=[],added:TaskCommentDraftFile[]=[];
      for(const file of incoming){
        const error=commentFileError(file);if(error){failures.push({name:file.name,code:error});continue;}
        if([...current.current,...added].some(item=>item.file.name===file.name&&item.file.size===file.size&&item.file.type===file.type&&item.file.lastModified===file.lastModified))continue;
        if(current.current.length+added.length>=COMMENT_FILE_COUNT){errorCallback.current(new CommentAttachmentError('attachment_count'));break;}
        let preview:string|undefined;if(/^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/.test(file.type)){try{preview=URL.createObjectURL(file);}catch{/* Preview is optional. */}}
        added.push({id:randomUUID(),file,preview,progress:0,status:'pending',resume:{}});
      }
      current.current=[...current.current,...added];setFiles(current.current);setRejected(failures);
    },
    remove(id:string){if(running.current||command.current)return;current.current.filter(file=>file.id===id).forEach(revoke);current.current=current.current.filter(file=>file.id!==id);setFiles(current.current);},
    async retryUpload(){
      if(running.current||command.current)return;running.current=true;setBusy(true);const request=new AbortController();controller.current=request;const key=generation.current;
      try{await upload(request.signal);}catch(error){if(!request.signal.aborted)errorCallback.current(error);}finally{if(key===generation.current){running.current=false;setBusy(false);}}
    },
    async publish(body:string,mentionIds:string[]):Promise<TaskCommentReceipt>{
      if(!taskId||running.current)throw new CommentAttachmentError('comment_busy');
      running.current=true;setBusy(true);const request=new AbortController();controller.current=request;const key=generation.current;
      let attemptedPublish=false;
      try{
        if(!command.current){await upload(request.signal);command.current={taskId,commandId:randomUUID(),body,uploadIds:current.current.map(file=>file.resume.attachment!.id),mentionIds};commandOutcomeUnknown.current=false;setPending(true);}
        const input=command.current;
        // Retry the immutable original command first. Unknown outcomes never create a second comment.
        let result:TaskCommentReceipt;
        try{result=await taskCommentClient.readback(input.commandId,request.signal);}
        catch(error){if((error as CommentAttachmentError).code!=='command_not_found')throw error;attemptedPublish=true;result=await taskCommentClient.publish(input,request.signal);}
        if(key!==generation.current||request.signal.aborted)throw new DOMException('Aborted','AbortError');
        current.current.forEach(revoke);current.current=[];setFiles([]);command.current=undefined;commandOutcomeUnknown.current=false;setPending(false);setRejected([]);
        await refresh(request.signal).catch(error=>{if(!request.signal.aborted)errorCallback.current(error);});
        return result;
      }catch(error){
        const failure=error as CommentAttachmentError;
        if(key===generation.current){
          const knownRejected=[400,403,410,413,422].includes(failure.status)||failure.code==='invalid_upload';
          if(attemptedPublish&&!knownRejected)commandOutcomeUnknown.current=true;
          // A later denial cannot prove that an earlier unknown write did not commit.
          if(knownRejected&&!commandOutcomeUnknown.current){command.current=undefined;setPending(false);}
        }
        throw error;
      }finally{if(key===generation.current){running.current=false;setBusy(false);}}
    },
    download:taskCommentClient.download,
  };
}
