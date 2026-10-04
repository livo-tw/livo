import { ApprovalCommandError, canonicalApprovalPayload, parseApprovalCommand } from './core.ts';

interface Environment { get(name: string): string | undefined; }
declare const Deno: { env: Environment; serve(handler: (request: Request) => Promise<Response>): void };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status,headers:{...cors,'Content-Type':'application/json'}});
const errors = new Set(['approval_forbidden','approval_invalid_input','approval_command_reused','approval_unavailable','approval_disabled',
  'approval_conflict','approval_pending','approval_invalid_transition','approval_not_required','approval_transition_prerequisite',
  'approval_invalid_steps','approval_legacy_snapshot','approval_rule_changed','approval_rule_in_use','approval_rule_has_history',
  'approval_ambiguous_rule','approval_command_required','approval_required','approval_self_decision_forbidden',
  'approval_requirement_admin_only']);

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
  } catch { throw new ApprovalCommandError('approval_unauthorized',401); }
}

/** Only a verified session supplies authId. Live membership/role is checked again in SQL. */
export function approvalHandler(env: Environment, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    if (request.method==='OPTIONS') return new Response(null,{status:204,headers:cors});
    if (request.method!=='POST') return json({error:'approval_method_not_allowed'},405);
    try {
      if (Number(request.headers.get('content-length')||0)>32768) throw new ApprovalCommandError('approval_request_too_large',413);
      const raw=await request.text();
      if (new TextEncoder().encode(raw).byteLength>32768) throw new ApprovalCommandError('approval_request_too_large',413);
      const command=parseApprovalCommand(JSON.parse(raw));
      const token=request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      const base=env.get('SUPABASE_URL')?.replace(/\/$/,''), anon=env.get('SUPABASE_ANON_KEY'), service=env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (!base||!anon||!service) throw new ApprovalCommandError('approval_unavailable',503);
      if (!token||token===anon||token===service) throw new ApprovalCommandError('approval_unauthorized',401);
      const auth=await fetcher(`${base}/auth/v1/user`,{headers:{apikey:anon,Authorization:`Bearer ${token}`},signal:AbortSignal.timeout(10000)});
      if (!auth.ok) throw new ApprovalCommandError('approval_unauthorized',401);
      const user=await auth.json();
      if (typeof user.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) {
        throw new ApprovalCommandError('approval_unauthorized',401);
      }
      const slackIdentity=verifiedSlackIdentity(token,user.id);
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalApprovalPayload(command))))]
        .map(value=>value.toString(16).padStart(2,'0')).join('');
      const response=await fetcher(`${base}/rest/v1/rpc/livo_approval_command`,{method:'POST',
        headers:{apikey:anon,Authorization:`Bearer ${service}`,'Content-Type':'application/json'},
        body:JSON.stringify({p_auth_id:user.id,p_command:command,p_payload_hash:hash,p_slack_identity:slackIdentity}),signal:AbortSignal.timeout(20000)});
      const result=await response.json().catch((): null=>null);
      if (!response.ok) {
        const known=typeof result?.message==='string'&&errors.has(result.message);
        const code=known?result.message:'approval_unavailable';
        const status=!known?503:result?.code==='42501'?403:['40001','PT409'].includes(result?.code)?409:result?.code==='P0002'?404:400;
        throw new ApprovalCommandError(code,status);
      }
      return json(result);
    } catch(error) {
      const code=error instanceof ApprovalCommandError?error.code:error instanceof SyntaxError?'approval_invalid_input':'approval_unavailable';
      return json({error:code},error instanceof ApprovalCommandError?error.status:error instanceof SyntaxError?400:503);
    }
  };
}
if (typeof Deno!=='undefined') Deno.serve(approvalHandler(Deno.env));
