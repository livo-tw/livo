/// <reference types="@cloudflare/workers-types" />
// @vitest-environment node
// Keep Worker runtime tests in the existing Worker Vitest include, so the
// frontend typechecker does not compile Worker modules with browser globals.
import {afterEach,describe,expect,it,vi} from 'vitest';
import {sendNotificationEmails} from '../src/functions/emailNotify';
import {trustedSlackRecipients} from '../src/slackBindingTrust';
import {createCloudQaSlackActions} from '../src/qaSlack';
import type {Env} from '../src/env';
afterEach(()=>vi.unstubAllGlobals());
const direct={id:'direct',email:'person@example.com',auth_id:'auth-direct',is_active:true,email_identity_verified:false};
type FakeRows = {results:Array<Record<string,unknown>>};
describe('Cloud email identity ownership',()=>{
  it('Cloud notification transport makes zero HTTP calls to a direct registration address',async()=>{
    const transport=vi.fn(async():Promise<never>=>{throw new Error('unexpected network call');});vi.stubGlobal('fetch',transport);
    const db={prepare:(sql:string)=>({bind:()=>({first:async():Promise<null>=>null,all:async():Promise<FakeRows>=>({results:sql.includes('FROM members')?[{...direct,name:'Example',is_active:1}]:[]})})})};
    await sendNotificationEmails({DB:db,RESEND_API_KEY:'example-only',APP_BASE_URL:'https://app.example.com'} as unknown as Env,[{workspace_id:'default',recipient_id:'direct',type:'mention',task_id:'',content:'Example notification'}]);
    expect(transport).not.toHaveBeenCalled();
  });
  it('Cloud delivery query checks email proof and issuer on both saved mapping kinds',async()=>{
    const prepared=vi.fn((_sql:string)=>({bind:()=>({all:async():Promise<{results:Array<{platform_user_id:string}>}>=>({results:[]})})}));
    expect(await trustedSlackRecipients({DB:{prepare:prepared}} as unknown as Env,'default','direct','TEXAMPLE')).toEqual([]);
    const query=prepared.mock.calls[0][0];
    expect(query).toContain("b.verified_by='email' AND m.email_identity_verified=1");
    expect(query).toContain("issuer.role='super_admin' AND issuer.is_active=1");
    expect(query).toContain('b.reconfirm_required=0');expect(query).toContain('pref.linking_disabled=1');
  });
  it('Cloud actor accepts deliberate owner mapping without an email match',async()=>{
    const slack=vi.fn(async(input:RequestInfo|URL):Promise<Response>=>Response.json(String(input).includes('auth.test')?{ok:true,team_id:'TEXAMPLE'}:{ok:true,user:{id:'UEXAMPLE',team_id:'TEXAMPLE',profile:{},locale:'en'}}));vi.stubGlobal('fetch',slack);
    const queries:string[]=[];
    const db={prepare:(query:string)=>{queries.push(query);return{bind:()=>({first:async():Promise<{bot_token:string}|null>=>query.includes('slack_config')?{bot_token:'example-only'}:null,
      all:async():Promise<FakeRows>=>({results:query.includes('FROM external_account_bindings')?[{...direct,name:'Example',role:'member'}]:[]})})};}};
    const actor=await createCloudQaSlackActions({DB:db} as unknown as Env,'default',{waitUntil:(_promise:Promise<unknown>):void=>{}} as never).actor({team_id:'TEXAMPLE',user_id:'UEXAMPLE'});
    expect(actor.id).toBe('direct');
    expect(queries.some(query=>query.includes('m.email=?'))).toBe(false);
    expect(slack.mock.calls.some(([url])=>String(url).includes('chat.postMessage')||String(url).includes('conversations.open'))).toBe(false);
  });
});
