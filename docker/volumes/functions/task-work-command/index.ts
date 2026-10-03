import { TaskWorkError, canonicalTaskWorkPayload, parseTaskWorkCommand } from './core.ts';

interface Environment { get(name: string): string | undefined; }
declare const Deno: { env: Environment; serve(handler: (request: Request) => Promise<Response>): void };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers:{...cors,'Content-Type':'application/json'}});
const errors = new Set(['work_forbidden','work_invalid_input','work_command_reused','work_unavailable','work_conflict','work_cycle','work_invalid_parent','work_member_unavailable','work_required_fields']);

/** Call only after GoTrue accepted this exact bearer token. Claims never come
 * from the HTTP body, and partial Slack identities cannot fall back to App auth. */
function verifiedSlackIdentity(token: string, authId: string) {
  try {
    const pieces=token.split('.');
    if (pieces.length!==3) throw new Error('invalid');
    const encoded=pieces[1].replace(/-/g,'+').replace(/_/g,'/');
    const claims=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length/4)*4,'=')),c=>c.charCodeAt(0))));
    if (!claims || typeof claims!=='object' || Array.isArray(claims) || claims.sub!==authId) throw new Error('invalid');
    const keys=['livo_slack_binding','livo_slack_team','livo_slack_user'];
    if (!Object.keys(claims).some(key=>key.startsWith('livo_slack_'))) return null;
    if (!keys.every(key=>typeof claims[key]==='string') || !/^[\w-]{1,200}$/.test(claims.livo_slack_binding)
      || !/^T[A-Z0-9]+$/.test(claims.livo_slack_team) || !/^[UW][A-Z0-9]+$/.test(claims.livo_slack_user)) throw new Error('invalid');
    return {bindingId:claims.livo_slack_binding,teamId:claims.livo_slack_team,userId:claims.livo_slack_user};
  } catch { throw new TaskWorkError('work_unauthorized',401); }
}

/** Only a verified session supplies authId. Live membership/role is checked again in SQL. */
export function taskWorkHandler(env: Environment, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    if (request.method!=='POST') return json({error:'work_method_not_allowed'},405);
    try {
      if (Number(request.headers.get('content-length')||0)>32768) throw new TaskWorkError('work_request_too_large',413);
      const raw=await request.text();
      if (new TextEncoder().encode(raw).byteLength>32768) throw new TaskWorkError('work_request_too_large',413);
      const command=parseTaskWorkCommand(JSON.parse(raw));
      const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      const base=env.get('SUPABASE_URL')?.replace(/\/$/,''), anon=env.get('SUPABASE_ANON_KEY'), service=env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!base||!anon||!service) throw new TaskWorkError('work_unavailable',503);
      if (!token||token===anon||token===service) throw new TaskWorkError('work_unauthorized',401);
      const auth=await fetcher(`${base}/auth/v1/user`,{headers:{apikey:anon,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if (!auth.ok) throw new TaskWorkError('work_unauthorized',401);
      const user=await auth.json();
      if (typeof user.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
        throw new TaskWorkError('work_unauthorized',401);
      }
      const slackIdentity=verifiedSlackIdentity(token,user.id);
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalTaskWorkPayload(command))))]
        .map(value=>value.toString(16).padStart(2,'0')).join('');
      const response=await fetcher(`${base}/rest/v1/rpc/livo_task_work_command`,{method:'POST',
        headers:{apikey:anon,Authorization:`Bearer ${service}`,'Content-Type':'application/json'},
        body:JSON.stringify({p_auth_id:user.id,p_command:command,p_payload_hash:hash,p_slack_identity:slackIdentity}),signal:AbortSignal.timeout(20000)});
      const result=await response.json().catch((): null=>null);
      if (!response.ok) {
        const known=typeof result?.message==='string'&&errors.has(result.message);
        const code=known?result.message:'work_unavailable';
        const status=!known?503:result?.code==='42501'?403:result?.code==='40001'?409:result?.code==='P0002'?404:400;
        throw new TaskWorkError(code,status);
      }
      return json(result);
    } catch(error) {
      const code=error instanceof TaskWorkError?error.code:error instanceof SyntaxError?'work_invalid_input':'work_unavailable';
      return json({error:code},error instanceof TaskWorkError?error.status:error instanceof SyntaxError?400:503);
    }
  };
}
if (typeof Deno!=='undefined') Deno.serve(taskWorkHandler(Deno.env));
