import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mock=vi.hoisted(()=>({list:vi.fn(),upload:vi.fn(),readback:vi.fn(),publish:vi.fn(),download:vi.fn()}));
vi.mock('@/lib/taskCommentClient',()=>({taskCommentClient:{list:mock.list,readback:mock.readback,publish:mock.publish,download:mock.download},uploadTaskCommentFile:mock.upload}));
import { useTaskCommentMedia } from '@/components/task-detail/hooks/useTaskCommentMedia';
import { CommentAttachmentError } from '@/lib/taskCommentAttachmentCore';
const media={id:'10000000-0000-4000-8000-000000000001',taskId:'task-example',fileName:'example.png',mimeType:'image/png',size:8};
const receipt={comment:{id:'20000000-0000-4000-8000-000000000001',task_id:'task-example',user_id:'member-example',content:'',created_at:'2026-01-01T00:00:00Z'},commentCount:1};
describe('task comment draft retry and account scope',()=>{
  beforeEach(()=>{
    vi.clearAllMocks();mock.list.mockResolvedValue({attachments:[]});mock.readback.mockRejectedValue(new CommentAttachmentError('command_not_found',404));
    mock.upload.mockImplementation(async(_task,_file,resume,progress)=>{resume.attachment=media;progress(100);return media;});mock.publish.mockResolvedValue(receipt);
  });
  it('keeps an unknown publish frozen and reads back the same command without uploading twice',async()=>{
    mock.publish.mockRejectedValueOnce(new TypeError('network_lost'));
    const {result}=renderHook(()=>useTaskCommentMedia('task-example','member-example',vi.fn()));
    act(()=>result.current.add([new File(['12345678'],'example.png',{type:'image/png'})]));
    await act(async()=>{await expect(result.current.publish('',[])).rejects.toThrow('network_lost');});
    expect(result.current.pending).toBe(true);expect(result.current.files).toHaveLength(1);
    const original=mock.publish.mock.calls[0][0];mock.readback.mockResolvedValueOnce(receipt);
    await act(async()=>{expect(await result.current.publish('changed draft is not a new command',[])).toEqual(receipt);});
    expect(mock.readback.mock.calls.at(-1)?.[0]).toBe(original.commandId);
    expect(mock.publish).toHaveBeenCalledTimes(1);expect(mock.upload).toHaveBeenCalledTimes(1);expect(result.current.files).toHaveLength(0);
  });
  it('retries a known upload failure while preserving earlier completed files',async()=>{
    let attempts=0;mock.upload.mockImplementation(async(_task,_file,resume)=>{if(++attempts===2)throw new Error('upload_failed');resume.attachment={...media,id:String(attempts)};return resume.attachment;});
    const {result}=renderHook(()=>useTaskCommentMedia('task-example','member-example',vi.fn()));
    act(()=>result.current.add([new File(['12345678'],'one.png',{type:'image/png'}),new File(['12345678'],'two.png',{type:'image/png'})]));
    await act(async()=>{await result.current.retryUpload();});expect(result.current.files.map(f=>f.status)).toEqual(['complete','failed']);
    await act(async()=>{await result.current.retryUpload();});expect(mock.upload).toHaveBeenCalledTimes(3);expect(result.current.files.every(f=>f.status==='complete')).toBe(true);
  });
  it('unfreezes a known rejected transaction while retaining the uploaded draft',async()=>{
    mock.publish.mockRejectedValueOnce(new CommentAttachmentError('forbidden',403));
    const {result}=renderHook(()=>useTaskCommentMedia('task-example','member-example',vi.fn()));
    act(()=>result.current.add([new File(['12345678'],'example.png',{type:'image/png'})]));
    await act(async()=>{await expect(result.current.publish('',[])).rejects.toThrow('forbidden');});
    expect(result.current.pending).toBe(false);expect(result.current.files).toHaveLength(1);
    act(()=>result.current.remove(result.current.files[0].id));expect(result.current.files).toHaveLength(0);
  });
  it('keeps an earlier unknown command after a later permission denial until its original receipt is readable',async()=>{
    mock.publish.mockRejectedValueOnce(new TypeError('response_lost_after_commit'));
    const {result}=renderHook(()=>useTaskCommentMedia('task-example','member-example',vi.fn()));
    act(()=>result.current.add([new File(['12345678'],'example.png',{type:'image/png'})]));
    await act(async()=>{await expect(result.current.publish('original body',[])).rejects.toThrow('response_lost_after_commit');});
    const original=mock.publish.mock.calls[0][0];
    mock.readback.mockRejectedValueOnce(new CommentAttachmentError('forbidden',403));
    await act(async()=>{await expect(result.current.publish('must not become another command',[])).rejects.toThrow('forbidden');});
    expect(result.current.pending).toBe(true);expect(result.current.files).toHaveLength(1);
    mock.readback.mockResolvedValueOnce(receipt);
    await act(async()=>{expect(await result.current.publish('still the original command',[])).toEqual(receipt);});
    expect(mock.readback.mock.calls.map(call=>call[0])).toEqual([original.commandId,original.commandId,original.commandId]);
    expect(mock.publish).toHaveBeenCalledTimes(1);expect(mock.upload).toHaveBeenCalledTimes(1);expect(result.current.pending).toBe(false);
  });
  it('clears files on a different account and ignores the old authorized list response',async()=>{
    let finish:(value:unknown)=>void=()=>{};mock.list.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
    const {result,rerender}=renderHook(({actor})=>useTaskCommentMedia('task-example',actor,vi.fn()),{initialProps:{actor:'member-example'}});
    act(()=>result.current.add([new File(['12345678'],'example.png',{type:'image/png'})]));rerender({actor:'other-member'});
    await act(async()=>{finish({attachments:[media]});});await waitFor(()=>expect(result.current.files).toHaveLength(0));expect(result.current.attachments).toHaveLength(0);
  });
});
