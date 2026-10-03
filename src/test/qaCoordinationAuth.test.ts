// @vitest-environment node
import {afterEach,describe,it,expect,vi} from 'vitest';
import {createQaService} from '../../docker/volumes/functions/qa/service';
const uid='00000000-0000-0000-0000-000000000001';
const env={get:(key:string)=>({SUPABASE_URL:'https://example.test',SUPABASE_ANON_KEY:'synthetic-anon',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service'} as Record<string,string>)[key]};
const token=(claims:Record<string,unknown>)=>`e30.${btoa(JSON.stringify({sub:uid,...claims}))}.synthetic-signature`;
const identity={livo_slack_binding:'binding-test',livo_slack_team:'TTEST',livo_slack_user:'UTEST'};
function fixture(authenticated=true){const calls:Array<{path:string;body:any}>=[];vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{const path=new URL(url).pathname;const body=init.body?JSON.parse(String(init.body)):undefined;calls.push({path,body});if(path==='/auth/v1/user')return Response.json(authenticated?{id:uid}:{},{status:authenticated?200:401});if(path==='/rest/v1/members')return Response.json([{id:'admin',role:'admin',auth_id:uid,is_active:true}]);if(path==='/rest/v1/system_settings')return Response.json([{value:{qa:true}}]);if(path==='/rest/v1/rpc/livo_qa_live_actor')return Response.json('admin');if(path==='/rest/v1/rpc/livo_qa_save_coordination')return Response.json({projectId:'p',coordinatorId:'coord',version:1});throw new Error('Unexpected synthetic request '+path);}));return calls;}
const request={action:'save_coordination',projectId:'p',coordinatorId:'coord',expectedVersion:0,commandId:'synthetic-config'};
afterEach(()=>vi.unstubAllGlobals());
describe('QA signed Slack identity boundary',()=>{
 it('verifies full token with GoTrue before parsing or using claims',async()=>{const calls=fixture(false);await expect(createQaService(env,token(identity)).handle(request)).rejects.toThrow('qa_unauthorized');expect(calls).toHaveLength(1);});
 it('binds SQL live checks and save RPC to signed claims, not request metadata',async()=>{const calls=fixture();await createQaService(env,token(identity)).handle({...request,slackIdentity:{bindingId:'forged',teamId:'TOTHER',userId:'UOTHER'}});const expected={bindingId:'binding-test',teamId:'TTEST',userId:'UTEST'};expect(calls.find(c=>c.path.endsWith('livo_qa_live_actor'))?.body).toEqual({p_auth_id:uid,p_identity:expected});expect(calls.find(c=>c.path.endsWith('livo_qa_save_coordination'))?.body).toMatchObject({p_auth_id:uid,p_slack_identity:expected});});
 it.each([{livo_slack_team:'TTEST'},{...identity,sub:'00000000-0000-0000-0000-000000000002'}])('rejects incomplete or mismatched signed identity',async claims=>{const calls=fixture();await expect(createQaService(env,token(claims)).handle(request)).rejects.toThrow('qa_forbidden');expect(calls.some(c=>c.path.endsWith('livo_qa_save_coordination'))).toBe(false);});
 it('does not upgrade a normal authenticated request using unsigned body identity',async()=>{const calls=fixture();await createQaService(env,token({})).handle({...request,slackIdentity:{bindingId:'forged'}});expect(calls.find(c=>c.path.endsWith('livo_qa_save_coordination'))?.body.p_slack_identity).toBeNull();});
});
