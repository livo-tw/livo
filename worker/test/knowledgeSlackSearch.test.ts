// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { searchCloudKnowledge } from '../src/knowledgeSlack';
import type { AuthCtx, Env } from '../src/env';
const databases: DatabaseSync[] = [];
const privatePolicy = JSON.stringify({ mode: 'custom', view: { roles: [], positions: ['Product'], member_ids: [] } });
function fixture() {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  db.exec(`CREATE TABLE members(id TEXT,workspace_id TEXT,role TEXT,job_title TEXT,is_active INTEGER);
    CREATE TABLE projects(id TEXT,workspace_id TEXT,name TEXT);
    CREATE TABLE kb_pages(id TEXT,workspace_id TEXT,parent_id TEXT,access_policy TEXT,admin_only INTEGER DEFAULT 0,
      is_archived INTEGER DEFAULT 0,title TEXT,body TEXT,category TEXT,project_id TEXT,updated_at TEXT,version INTEGER);`);
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?)').run('reader','one','member','Development',1);
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?)').run('product','one','member','Product',1);
  db.prepare('INSERT INTO members VALUES(?,?,?,?,?)').run('owner','one','super_admin','Owner',1);
  db.exec('ALTER TABLE members ADD COLUMN auth_id TEXT; UPDATE members SET auth_id=id;');
  function page(id: string, policy = '{"mode":"inherit"}', parent: string | null = null, ws = 'one') {
    db.prepare('INSERT INTO kb_pages(id,workspace_id,parent_id,access_policy,title,body,category,updated_at,version) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, ws, parent, policy, `Release ${id}`, '<p>Release rules</p>', 'meeting', '2026-01-01', 1);
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
      expect(result.pages.map((p: {id: string}) => p.id)).toEqual(['public']); expect(result.hasMore).toBe(false);
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
  it('paginates after permission filtering and treats SQL punctuation as literal search text', async () => {
    const f = fixture(); for(let i=0;i<7;i++) f.page(`private-${i}`,privatePolicy);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:0,category:'all'})).hasMore).toBe(false);
    for(let i=0;i<7;i++) f.page(`public-${i}`);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:0,category:'all'})).pages).toHaveLength(5);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:'Release',page:1,category:'all'})).pages).toHaveLength(3);
    expect((await searchCloudKnowledge(f.env,f.actor('reader'),{text:"' OR 1=1 --",page:0,category:'all'})).pages).toHaveLength(0);
  });
});
