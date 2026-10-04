// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { searchCloudKnowledge } from '../src/knowledgeSlack';
import type { AuthCtx, Env } from '../src/env';
const databases: DatabaseSync[] = [];
const privatePolicy = JSON.stringify({ mode: 'custom', view: { roles: [], positions: ['Product'], member_ids: [] } });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  // Use the production schema instead of a stale handwritten KB table subset.
  db.exec('PRAGMA foreign_keys=ON');
  db.exec(readFileSync(path.resolve(__dirname, '../schema.sql'), 'utf8'));
  for(const [id,role,position] of [['reader','member','Development'],['product','member','Product'],['owner','super_admin','Owner']]){
    db.prepare('INSERT INTO auth_users(id,email) VALUES(?,?)').run(id,`${id}@example.com`);
    db.prepare('INSERT INTO members(id,workspace_id,name,avatar,role,job_title,is_active,email,auth_id) VALUES(?,?,?,?,?,?,?,?,?)').run(id,'one',id,'',role,position,1,`${id}@example.com`,id);
  }
  function page(id: string, policy = '{"mode":"inherit"}', parent: string | null = null, ws = 'one') {
    db.prepare('INSERT INTO kb_pages(id,workspace_id,parent_id,access_policy,title,body,category,updated_at,version,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, ws, parent, policy, `Release ${id}`, '<p>Release rules</p>', 'meeting', '2026-01-01', 1, 'product', 'product');
  }
  page('public'); page('private', privatePolicy); page('private-child', '{"mode":"inherit"}', 'private');
  page('other-workspace', '{"mode":"inherit"}', null, 'two');
  const env = { DB: { prepare(sql: string) { return { bind(...values: unknown[]) { return {
    all: async () => ({ results: db.prepare(sql).all(...values as (string | number | null)[]) }),
  }; } }; } } } as unknown as Env;
  const actor = (id: string): AuthCtx => ({ userId: id, email: `${id}@example.com`, member: { id, name: id, role: 'member', email: `${id}@example.com`, workspaceId: 'one' } });
  return { db, env, actor, page };
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe('knowledge Slack live ACL search', () => {
  it('denies results after the live authentication identity is detached',async()=>{
    const f=fixture(),cached=f.actor('product');
    f.db.prepare('UPDATE members SET auth_id=NULL WHERE id=?').run('product');
    const result=await searchCloudKnowledge(f.env,cached,{text:'Release',page:0,category:'all'});
    expect(result.pages).toEqual([]);expect(result.hasMore).toBe(false);
  });
  it('omits private ancestors, titles, counts and other workspaces for readers and unlisted administrators', async () => {
    const f = fixture();
    for (const id of ['reader','owner']) {
      const result = await searchCloudKnowledge(f.env,f.actor(id),{text:'Release',page:0,category:'all'});
      expect(result.pages.map(p => String(p.id))).toEqual(['public']); expect(result.hasMore).toBe(false);
      expect(result.pages[0]).not.toHaveProperty('body'); expect(result.pages[0]).not.toHaveProperty('access_policy');
    }
  });
  it('uses live position data and immediately denies subsequent queries after role or ancestor revocation', async () => {
    const f = fixture(); const first = await searchCloudKnowledge(f.env,f.actor('product'),{text:'Release',page:0,category:'meeting'});
    expect(first.pages).toHaveLength(3);
    f.db.prepare('UPDATE members SET job_title=? WHERE id=?').run('Development','product');
    expect((await searchCloudKnowledge(f.env,f.actor('product'),{text:'Release',page:0,category:'all'})).pages).toHaveLength(1);
    f.db.prepare('UPDATE members SET is_active=0 WHERE id=?').run('reader');
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:0,category:'all'})).pages).toHaveLength(0);
  });
  it('does not reveal an owner-only draft or its inherited child to other readers or super administrators',async()=>{
    const f=fixture();
    f.db.exec("BEGIN; INSERT INTO kb_work_contexts(workspace_id,id,actor_id,auth_id,page_id,operation,expected_generation,lease_pages) SELECT 'one','seed-draft','product','product','draft','save_draft',generation,'[]' FROM kb_work_clock WHERE workspace_id='one'; INSERT INTO kb_pages(workspace_id,id,title,created_by,updated_by,private_draft_owner_id) VALUES('one','draft','Release draft','product','product','product'); DELETE FROM kb_work_contexts WHERE workspace_id='one' AND id='seed-draft'; COMMIT;");
    f.page('draft-child','{"mode":"inherit"}','draft');
    const own=await searchCloudKnowledge(f.env,f.actor('product'),{text:'Release',page:0,category:'all'});
    expect(own.pages.map(p=>p.id)).toContain('draft');expect(own.pages.map(p=>p.id)).toContain('draft-child');
    for(const id of ['reader','owner']){
      const result=await searchCloudKnowledge(f.env,f.actor(id),{text:'Release',page:0,category:'all'});
      expect(result.pages.map(p=>p.id)).toEqual(['public']);expect(result.hasMore).toBe(false);
    }
  });
  it('paginates after permission filtering and treats SQL punctuation as literal search text', async () => {
    const f = fixture(); for(let i=0;i<7;i++) f.page(`private-${i}`,privatePolicy);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:0,category:'all'})).hasMore).toBe(false);
    for(let i=0;i<7;i++) f.page(`public-${i}`);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:0,category:'all'})).pages).toHaveLength(5);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:1,category:'all'})).pages).toHaveLength(3);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:"' OR 1=1 --",page:0,category:'all'})).pages).toHaveLength(0);
  });
});
