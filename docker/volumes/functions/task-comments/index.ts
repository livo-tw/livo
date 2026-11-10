import { createTaskCommentService } from './service.ts';
import { CommentAttachmentError } from './core.ts';
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
Deno.serve(async(request: Request)=>{
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  try{
    if(request.method!=='POST')throw new CommentAttachmentError('method_not_allowed',405);
    const reader=request.body?.getReader();if(!reader)throw new CommentAttachmentError('invalid_json');
    const pieces:Uint8Array[]=[];let size=0;
    try{for(;;){const item=await reader.read();if(item.done)break;size+=item.value.length;if(size>65536)throw new CommentAttachmentError('request_size',413);pieces.push(item.value);}}finally{await reader.cancel();}
    const bytes=new Uint8Array(size);let offset=0;for(const piece of pieces){bytes.set(piece,offset);offset+=piece.length;}const raw=new TextDecoder().decode(bytes);
    const result=await createTaskCommentService(Deno.env,request.headers.get('authorization')?.replace(/^Bearer /i,'')||'').handle(JSON.parse(raw));
    if(result instanceof Response){for(const[k,v]of Object.entries(cors))result.headers.set(k,v);return result;}
    return new Response(JSON.stringify(result),{headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
  }catch(error){const e=error instanceof CommentAttachmentError?error:error instanceof SyntaxError?new CommentAttachmentError('invalid_json'):new CommentAttachmentError('task_comment_failed',500);return new Response(JSON.stringify({error:{code:e.code,message:e.code}}),{status:e.status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});}
});
