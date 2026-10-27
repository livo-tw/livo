// @vitest-environment node
import { describe,expect,it,vi } from 'vitest';
import { RealtimeHub } from '../../worker/src/realtime';
import { notifyChanges } from '../../worker/src/notify';
import { backendAccessFixture } from '../../worker/test/backendAccessFixture';

describe('private knowledge realtime payloads',()=>{
  it('strips titles, content, comments and old bodies before transport',async()=>{
    const fetch=vi.fn(async()=>new Response('ok')); const pending=[];
    const env={REALTIME:{idFromName:v=>v,get:()=>({fetch})}};
    notifyChanges(env,{waitUntil:p=>pending.push(p)},[{table:'kb_pages',eventType:'DELETE',new:null,old:{id:'private',title:'Private title',body:'Private body'}}]);
    await Promise.all(pending);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual([{table:'kb_pages',eventType:'DELETE',new:{},old:null}]);
  });
  it('also strips raw private data at the hub while preserving ordinary events',async()=>{
    const fixture=backendAccessFixture();
    try {
      const hub=new RealtimeHub({},fixture.env); const socket={send:vi.fn(),close:vi.fn()};
      hub.sockets.set(socket,{userId:'login-member',memberId:'member',workspaceId:'access-a',email:'member@example.com',expiresAt:Math.floor(Date.now()/1000)+3600,
        lastSeen:Date.now(),channels:new Map([['all',{bindings:[{table:'kb_comments',event:'*'},{table:'tasks',event:'*'}]}]])});
      const events=[{table:'kb_comments',eventType:'UPDATE',new:{id:'private',page_id:'private-page',body:'Private comment'},old:{body:'Old private comment'}},{table:'tasks',eventType:'UPDATE',new:{id:'task'},old:null}];
      const response=await hub.fetch(new Request('https://do/notify',{method:'POST',headers:{'x-workspace-id':'access-a'},body:JSON.stringify(events)}));
      expect(response.status).toBe(200); expect(socket.close).not.toHaveBeenCalled();
      const sent=socket.send.mock.calls.map(([value])=>JSON.parse(value));
      expect(sent).toHaveLength(2);
      expect(sent[0].new).toEqual({}); expect(sent[0].old).toBeNull();
      expect(JSON.stringify(sent)).not.toContain('Private'); expect(sent[1].new).toEqual({id:'task'});
    } finally { fixture.db.close(); }
  });
});
