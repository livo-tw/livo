import { describe, expect, it } from 'vitest';
import { COMMENT_FILE_LIMIT, commentFileError, commentPublishInput, commentSignature } from '@/lib/taskCommentAttachmentCore';
const id='10000000-0000-4000-8000-000000000001';
describe('private ordinary task comment attachment contract',()=>{
  it('accepts the existing 200MB limit and rejects empty and oversized files',()=>{
    expect(commentFileError({name:'example.mp4',type:'video/mp4',size:COMMENT_FILE_LIMIT})).toBeUndefined();
    expect(commentFileError({name:'example.mp4',type:'video/mp4',size:COMMENT_FILE_LIMIT+1})).toBe('file_size');
    expect(commentFileError({name:'example.png',type:'image/png',size:0})).toBe('file_size');
  });
  it('rejects traversal, active formats and MIME/extension mismatches',()=>{
    expect(commentFileError({name:'../example.png',type:'image/png',size:8})).toBe('file_name');
    expect(commentFileError({name:'example.svg',type:'image/svg+xml',size:8})).toBe('file_type');
    expect(commentFileError({name:'example.html',type:'image/png',size:8})).toBe('file_type');
  });
  it('validates image and video bytes instead of trusting the browser MIME',()=>{
    expect(()=>commentSignature('image/png',new Uint8Array([137,80,78,71,13,10,26,10]))).not.toThrow();
    expect(()=>commentSignature('video/webm',new Uint8Array([0x1a,0x45,0xdf,0xa3]))).not.toThrow();
    expect(()=>commentSignature('image/png',new TextEncoder().encode('<script>bad</script>'))).toThrow('file_signature');
    expect(()=>commentSignature('text/plain',new TextEncoder().encode('<svg></svg>'))).toThrow('file_signature');
  });
  it('accepts attachment-only comments and deduplicates mention recipients',()=>{
    const parsed=commentPublishInput({taskId:'task-example',commandId:id,body:'<p></p>',uploadIds:[id],mentionIds:['member-example','member-example']});
    expect(parsed.mentionIds).toEqual(['member-example']);
  });
  it('rejects empty content, duplicate attachments and more than ten files',()=>{
    const base={taskId:'task-example',commandId:id,body:'',uploadIds:[] as string[],mentionIds:[] as string[]};
    expect(()=>commentPublishInput(base)).toThrow('invalid_comment');
    expect(()=>commentPublishInput({...base,uploadIds:[id,id]})).toThrow('attachment_count');
    expect(()=>commentPublishInput({...base,uploadIds:Array.from({length:11},(_,n)=>`10000000-0000-4000-8000-${String(n).padStart(12,'0')}`)})).toThrow('attachment_count');
  });
});
