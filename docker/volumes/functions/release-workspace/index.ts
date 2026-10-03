import { createReleaseService, type ReleaseEnvironment } from './service.ts';
import { releaseError, ReleaseError } from './core.ts';
declare const Deno:{env:ReleaseEnvironment;serve(handler:(request:Request)=>Promise<Response>):void};
const cors={'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS'};
export function releaseWorkspaceHandler(env:ReleaseEnvironment){return async(request:Request):Promise<Response>=>{
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:cors});
  if(request.method!=='POST')return json({error:'release_method_not_allowed'},405);
  try{if(Number(request.headers.get('content-length')||0)>262144)throw new ReleaseError('release_limit_reached',413);
    const raw=await request.text();if(new TextEncoder().encode(raw).byteLength>262144)throw new ReleaseError('release_limit_reached',413);
    return json(await createReleaseService(env,request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1]||'').handle(JSON.parse(raw)));
  }catch(error){const e=error instanceof SyntaxError?new ReleaseError('release_invalid_input'):releaseError(error);return json({error:e.code},e.status);}
};}
if(typeof Deno!=='undefined')Deno.serve(releaseWorkspaceHandler(Deno.env));
