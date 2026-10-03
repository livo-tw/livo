// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { handleKnowledgePreferences } from '../src/knowledgePreferences';
import { applyNavigation, emptyNavigation, navigationScope, orderedNavigation, visibleNavigation } from '../src/knowledgePreferenceModel';
import type { AuthCtx, Env } from '../src/env';

let db: DatabaseSync, env: Env;
const actor = (id='reader',workspaceId='alpha',role='member'):AuthCtx => ({userId:id,email:`${id}@example.com`,member:{id,workspaceId,role,email:`${id}@example.com`,name:'Example'}});
const page = (id:string,parent_id:string|null=null,sort_order=0) => ({id,parent_id,project_id:null,sort_order,title:id});
beforeEach(()=>{
  db=new DatabaseSync(':memory:');
  // Exercise the actual merged schema, including private-draft ACL columns and guards.
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8'));
  db.exec(`INSERT INTO auth_users(id,email) VALUES('reader','reader@example.com'),('other','other@example.com'),('beta-reader','beta-reader@example.com');
    INSERT INTO members(workspace_id,id,name,avatar,is_active,role,job_title,email,auth_id) VALUES
      ('alpha','reader','Reader','',1,'member','Engineer','reader@example.com','reader'),
      ('alpha','other','Other','',1,'super_admin','Engineer','other@example.com','other'),
      ('beta','beta-reader','Beta reader','',1,'member','Engineer','beta-reader@example.com','beta-reader');`);
  const insert=db.prepare('INSERT INTO kb_pages(workspace_id,id,parent_id,project_id,sort_order,title,access_policy,created_by,updated_by) VALUES(?,?,?,NULL,0,?,?,?,?)');
  for(const ws of ['alpha','beta'])for(const [id,parent]of [['a',null],['b',null],['c',null],['child','a']]as const){
    const prefix=ws==='beta'?'beta-':'',owner=ws==='beta'?'beta-reader':'reader';
    insert.run(ws,prefix+id,parent?prefix+parent:null,id,'{"mode":"inherit"}',owner,owner);
  }
  env={DB:{prepare:(sql:string)=>({bind:(...values:(string|number)[])=>({first:async()=>db.prepare(sql).get(...values)||null,all:async()=>({results:db.prepare(sql).all(...values)})})})}} as unknown as Env;
});
afterEach(()=>db.close());

describe('persistent knowledge navigation',()=>{
  it('denies a cached session after its authentication binding changes',async()=>{
    await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'a',p_value:true,p_version:0});
    db.prepare('UPDATE members SET auth_id=? WHERE workspace_id=? AND id=?').run('replacement','alpha','reader');
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'read'})).error?.message).toBe('kb_forbidden');
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'b',p_value:true,p_version:1})).error?.message).toBe('kb_forbidden');
  });
  it('keeps pins inside favorites and persists for the same owner only',async()=>{
    const first=await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'a',p_value:true,p_version:0});
    expect(first.error).toBeNull(); expect(first.data?.items.a).toEqual({favorite:true,pinned:true});
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'read'})).data?.pins).toEqual(['a']);
    expect((await handleKnowledgePreferences(env,actor('other'),{p_action:'read'})).data?.pins).toEqual([]);
    expect((await handleKnowledgePreferences(env,actor('beta-reader','beta'),{p_action:'read'})).data?.pins).toEqual([]);
    const unpin=await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'a',p_value:false,p_version:1});
    expect(unpin.data?.items.a).toEqual({favorite:true,pinned:false});
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'favorite',p_page_id:'a',p_value:false,p_version:2})).data?.items.a).toEqual({favorite:false,pinned:false});
  });
  it('rejects stale writes, owner injection and cross-parent moves without changing shared rows',async()=>{
    const initial=db.prepare('SELECT * FROM kb_pages ORDER BY workspace_id,id').all();
    const move=await handleKnowledgePreferences(env,actor(),{p_action:'reorder',p_page_id:'b',p_before_id:'a',p_version:0});
    expect(move.error).toBeNull();expect(move.data?.orders['[null,null]']).toEqual(['b','a','c']);
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'collapse',p_page_id:'a',p_value:true,p_version:0})).error?.message).toBe('kb_conflict');
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'reorder',p_page_id:'child',p_before_id:'b',p_version:1})).error?.message).toBe('kb_invalid_request');
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'read',member_id:'other'})).error?.message).toBe('kb_invalid_request');
    expect(db.prepare('SELECT * FROM kb_pages ORDER BY workspace_id,id').all()).toEqual(initial);
  });
  it('removes revoked IDs and counts, including for super administrators',async()=>{
    await handleKnowledgePreferences(env,actor('other'),{p_action:'pin',p_page_id:'a',p_value:true,p_version:0});
    const policy=JSON.stringify({mode:'custom',view:{roles:[],positions:['Planning'],member_ids:[]},edit:{roles:[],positions:[],member_ids:[]},comment:{roles:[],positions:[],member_ids:[]}});
    db.prepare("UPDATE kb_pages SET access_policy=? WHERE workspace_id='alpha' AND id='a'").run(policy);
    const read=await handleKnowledgePreferences(env,actor('other'),{p_action:'read'});
    expect(read.data?.items).toEqual({});expect(read.data?.pins).toEqual([]);expect(read.data?.orders).toEqual({});
    expect((await handleKnowledgePreferences(env,actor('other'),{p_action:'favorite',p_page_id:'child',p_value:true,p_version:1})).error?.message).toBe('kb_forbidden');
    db.exec("UPDATE members SET is_active=0 WHERE workspace_id='alpha' AND id='other'");
    expect((await handleKnowledgePreferences(env,actor('other'),{p_action:'read'})).error?.message).toBe('kb_forbidden');
  });
  it('keeps owner-only draft preferences hidden even from a different super administrator',async()=>{
    db.exec("BEGIN; INSERT INTO kb_work_contexts(workspace_id,id,actor_id,auth_id,page_id,operation,expected_generation,lease_pages) SELECT 'alpha','seed-draft','reader','reader','draft','save_draft',generation,'[]' FROM kb_work_clock WHERE workspace_id='alpha'; INSERT INTO kb_pages(workspace_id,id,title,created_by,updated_by,private_draft_owner_id) VALUES('alpha','draft','Private draft','reader','reader','reader'); DELETE FROM kb_work_contexts WHERE workspace_id='alpha' AND id='seed-draft'; COMMIT;");
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'draft',p_value:true,p_version:0})).error).toBeNull();
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'read'})).data?.pins).toEqual(['draft']);
    expect((await handleKnowledgePreferences(env,actor('other'),{p_action:'favorite',p_page_id:'draft',p_value:true,p_version:0})).error?.message).toBe('kb_forbidden');
    expect((await handleKnowledgePreferences(env,actor('reader','beta'),{p_action:'read'})).error?.message).toBe('kb_forbidden');
  });
  it('checks current permission inside the mutation statement',async()=>{
    const base=env.DB.prepare.bind(env.DB);
    env.DB.prepare=((sql:string)=>{
      if(sql.startsWith('INSERT INTO kb_navigation_preferences'))db.exec("UPDATE members SET is_active=0 WHERE workspace_id='alpha' AND id='reader'");
      return base(sql);
    }) as typeof env.DB.prepare;
    expect((await handleKnowledgePreferences(env,actor(),{p_action:'pin',p_page_id:'a',p_value:true,p_version:0})).data).toBeNull();
    expect(db.prepare('SELECT count(*) AS n FROM kb_navigation_preferences').get()?.n).toBe(0);
  });
});

describe('personal order merges',()=>{
  it('appends new pages without resetting old order and drops moved IDs from the old group',()=>{
    const pages=[page('a'),page('b'),page('c')];
    const prefs=applyNavigation(emptyNavigation(),pages,{p_action:'reorder',p_page_id:'b',p_before_id:'a'});
    expect(orderedNavigation([...pages,page('new',null,-20)],prefs.orders[navigationScope(pages[0])]).map(p=>p.id)).toEqual(['b','a','c','new']);
    const visible=visibleNavigation(prefs,[page('a'),page('b','a'),page('c')]);
    expect(visible.orders['[null,null]']).toEqual(['a','c']);
  });
  it('favorite removal unpins atomically while collapse does not reorder pins',()=>{
    const pages=[page('a'),page('b')];let prefs=emptyNavigation();
    for(const id of ['a','b'])prefs=applyNavigation(prefs,pages,{p_action:'pin',p_page_id:id,p_value:true});
    prefs=applyNavigation(prefs,pages,{p_action:'collapse',p_page_id:'a',p_value:true});expect(prefs.pins).toEqual(['a','b']);
    prefs=applyNavigation(prefs,pages,{p_action:'favorite',p_page_id:'a',p_value:false});expect(prefs.pins).toEqual(['b']);expect(prefs.items.a.pinned).toBe(false);
  });
});
