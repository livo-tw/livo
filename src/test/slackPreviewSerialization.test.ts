import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import { createCfClient } from '@/integrations/backend/cfClient';
const previous={enabled:true,teamId:'TEXAMPLE',routes:[{projectId:'example-project',channelId:'CEXAMPLE'}],weekly:{enabled:false}};
const next={...previous,previewMode:'internal_channels'};
afterEach(()=>{vi.unstubAllGlobals();localStorage.removeItem('livo-auth');});
describe('preview settings CAS on the actual client serializers',()=>{
  it('sends a JSONB literal through the real Supabase SDK instead of coercing an object',async()=>{
    let filter:string|null=null;
    const transport=vi.fn(async(input:RequestInfo|URL)=>{
      filter=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url).searchParams.get('value');
      return new Response(JSON.stringify([{value:next}]),{status:200,headers:{'Content-Type':'application/json'}});
    });
    const client=createClient('https://example.com','synthetic-public-key',{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{fetch:transport}});
    const result=await client.from('system_settings').update({value:next}).eq('key','slack_delivery').eq('value',JSON.stringify(previous)).select('value');
    expect(result.error).toBeNull();expect(filter).toBe('eq.'+JSON.stringify(previous));expect(filter).not.toContain('[object Object]');expect(transport).toHaveBeenCalledTimes(1);
  });
  it('keeps the original JSON text in the actual Cloudflare query protocol filter',async()=>{
    localStorage.removeItem('livo-auth');let request:Record<string,any>|undefined;
    vi.stubGlobal('fetch',vi.fn(async(_input:unknown,init:RequestInit)=>{request=JSON.parse(String(init.body));return new Response(JSON.stringify({data:[{value:next}],error:null}),{headers:{'Content-Type':'application/json'}});}));
    const client=createCfClient() as {from(table:string):any};
    const result=await client.from('system_settings').update({value:next}).eq('key','slack_delivery').eq('value',JSON.stringify(previous)).select('value');
    expect(result.error).toBeNull();const filter=request?.filters.find((entry:Record<string,unknown>)=>entry.col==='value');expect(typeof filter.val).toBe('string');expect(filter.val).toBe(JSON.stringify(previous));expect(JSON.parse(filter.val)).toEqual(previous);
  });
});
