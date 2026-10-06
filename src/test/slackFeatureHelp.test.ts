// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpText, handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import { homeModal } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import { createActions, type Environment } from '../../docker/volumes/functions/slack-interact/backend';
const approvalButtons=(view:ReturnType<typeof homeModal>)=>(view.blocks as Array<{elements?:Array<{action_id?:string}>}>).flatMap(block=>block.elements||[]).filter(item=>item.action_id==='livo_approvals_page');
afterEach(()=>vi.unstubAllGlobals());
describe('Slack help and approval feature controls',()=>{
 it.each(['zh-TW','zh-CN','en'])('shows only enabled commands in %s and omits obsolete confirmation and pause workflows',locale=>{
   const help=helpText({locale,approvals:true},{approvals:false});
   expect(help).toContain('/livo context ABC-123');expect(help).toContain('/livo deadline ABC-123');
   expect(help).not.toContain('/livo approvals');expect(help).not.toContain('/livo pause');expect(help).not.toContain('/livo reminders');
   expect(help).not.toContain('接手確認');
   expect(helpText({locale},{approvals:true})).toContain('/livo approvals');
 });
 it('does not accept an approval feature claim from modal metadata',()=>{
   expect(approvalButtons(homeModal({locale:'en',approvals:true,flags:{approvals:true}}))).toHaveLength(0);
   expect(approvalButtons(homeModal({locale:'en'},{approvals:false}))).toHaveLength(0);
   expect(approvalButtons(homeModal({locale:'en'},{approvals:true}))).toHaveLength(1);
 });
 it.each([false,true])('uses current server flags rather than message metadata for help: enabled=%s',async approvals=>{
   const reply=vi.fn(),d={enabled:vi.fn(async()=>true),actor:vi.fn(async()=>({id:'member-example',locale:'en'})),flags:vi.fn(async()=>({approvals})),reply} as unknown as Actions;
   await handleInteraction({command:'/livo',text:'help',flags:{approvals:!approvals}},'example-envelope',d);
   expect(d.flags).toHaveBeenCalledTimes(1);
   expect(reply.mock.calls[0][1].includes('/livo approvals')).toBe(approvals);
 });
 it.each([false,true,'true',undefined])('requires an actual stored boolean approval setting: %s',async approvals=>{
   const fetch=vi.fn(async(_input:RequestInfo | URL)=>new Response(JSON.stringify([{value:{approvals,slackActions:true}}]),{status:200,headers:{'content-type':'application/json'}}));
   vi.stubGlobal('fetch',fetch);
   const actions=createActions({get:(key:string)=>({SUPABASE_URL:'https://example.com',SUPABASE_SERVICE_ROLE_KEY:'fictional-service-key'} as Record<string,string>)[key]} as Environment,()=>{});
   expect(await actions.flags!()).toEqual({approvals:approvals===true});
   expect(String(fetch.mock.calls[0]?.[0])).toContain('key=eq.feature_toggles');
 });
});
