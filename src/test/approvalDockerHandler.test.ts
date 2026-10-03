// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {approvalHandler} from '../../docker/volumes/functions/approval-command/index';
const values:Record<string,string>={SUPABASE_URL:'https://example.com',SUPABASE_ANON_KEY:'example-anon',SUPABASE_SERVICE_ROLE_KEY:'example-service'};
const env={get:(key:string)=>values[key]};
const command={commandId:'command-example',operation:'set_requirement',taskId:'task-example',expectedRequiresApproval:false,enabled:true};
const authId='00000000-0000-0000-0000-000000000001';
// Syntactically valid fixture tokens. Authentication is explicitly mocked below;
// these are not signed credentials and must never be accepted by a real server.
const session=(claims:Record<string,unknown>={})=>`${btoa('{"alg":"HS256"}')}.${btoa(JSON.stringify({sub:authId,...claims}))}.fixture-signature`;
const req=(token=session(),body:unknown=command)=>new Request('https://example.com/functions/approval-command',{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});
describe('Docker approval command authentication boundary',()=>{
  it('only uses verified auth user UUID and canonical server hash',async()=>{
    const fetcher=vi.fn(async(url:RequestInfo|URL,_init?:RequestInit)=>String(url).endsWith('/auth/v1/user')
      ?Response.json({id:'00000000-0000-0000-0000-000000000001'}):Response.json({commandId:command.commandId,replayed:false}));
    const response=await approvalHandler(env,fetcher as typeof fetch)(req());expect(response.status).toBe(200);
    const call=fetcher.mock.calls[1];const payload=JSON.parse(String(call[1]?.body));
    expect(payload.p_auth_id).toBe('00000000-0000-0000-0000-000000000001');expect(payload.p_command).toEqual(command);
    expect(payload.p_slack_identity).toBeNull();
    expect(payload.p_payload_hash).toMatch(/^[a-f0-9]{64}$/);expect((call[1]?.headers as Record<string,string>).Authorization).toBe('Bearer example-service');
  });
  it('forwards complete Slack identity only after GoTrue accepted that token',async()=>{
    const token=session({livo_slack_binding:'binding-example',livo_slack_team:'TEXAMPLE',livo_slack_user:'UEXAMPLE'});
    const fetcher=vi.fn(async(url:RequestInfo|URL,_init?:RequestInit)=>String(url).endsWith('/auth/v1/user')
      ?Response.json({id:authId}):Response.json({commandId:command.commandId,replayed:false}));
    expect((await approvalHandler(env,fetcher)(req(token))).status).toBe(200);
    expect((fetcher.mock.calls[0][1]?.headers as Record<string,string>).Authorization).toBe(`Bearer ${token}`);
    expect(JSON.parse(String(fetcher.mock.calls[1][1]?.body)).p_slack_identity).toEqual({bindingId:'binding-example',teamId:'TEXAMPLE',userId:'UEXAMPLE'});
  });
  it('rejects a forged token before reading its Slack claims or invoking the RPC',async()=>{
    const fetcher=vi.fn(async()=>Response.json({error:'bad_signature'},{status:401}));
    const token=session({livo_slack_binding:'binding-example',livo_slack_team:'TEXAMPLE',livo_slack_user:'UEXAMPLE'});
    expect((await approvalHandler(env,fetcher)(req(token))).status).toBe(401);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('rejects partial, invalid or mismatched verified claims without falling back to app auth',async()=>{
    for(const claims of [{livo_slack_binding:'binding-example'},{livo_slack_team:'TEXAMPLE'},{livo_slack_source:{}},
      {livo_slack_binding:null,livo_slack_team:'TEXAMPLE',livo_slack_user:'UEXAMPLE'},
      {livo_slack_binding:'binding-example',livo_slack_team:'foreign',livo_slack_user:'UEXAMPLE'},
      {sub:'00000000-0000-0000-0000-000000000002'}]){
      const fetcher=vi.fn(async()=>Response.json({id:authId}));
      expect((await approvalHandler(env,fetcher)(req(session(claims)))).status).toBe(401);expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });
  it('never accepts Slack identity from the client command body',async()=>{
    const fetcher=vi.fn();
    expect((await approvalHandler(env,fetcher)(req(session(),{...command,p_slack_identity:{bindingId:'forged'}}))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects service keys and caller actor spoofing without any fetch',async()=>{
    const fetcher=vi.fn();const handler=approvalHandler(env,fetcher);
    expect((await handler(req('example-service'))).status).toBe(401);
    expect((await handler(req('example-anon'))).status).toBe(401);
    expect((await handler(req('example-session',{...command,actorId:'admin'}))).status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('rejects invalid verified identity and never invokes privileged RPC',async()=>{
    const fetcher=vi.fn(async()=>Response.json({id:'member-alias'}));
    expect((await approvalHandler(env,fetcher)(req())).status).toBe(401);expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('returns stable whitelisted database errors and hides internal diagnostic detail',async()=>{
    for(const [db,error,status] of [[{code:'40001',message:'approval_conflict'},'approval_conflict',409],
      [{code:'42501',message:'approval_forbidden'},'approval_forbidden',403],
      [{code:'P0002',message:'approval_unavailable'},'approval_unavailable',404],
      [{code:'42P01',message:'private internal detail'},'approval_unavailable',503]] as const){
      const fetcher=vi.fn(async(url:RequestInfo|URL)=>String(url).endsWith('/auth/v1/user')
        ?Response.json({id:'00000000-0000-0000-0000-000000000001'}):Response.json(db,{status:400}));
      const response=await approvalHandler(env,fetcher)(req());expect(response.status).toBe(status);expect(await response.json()).toEqual({error});
    }
  });
});
