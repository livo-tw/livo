// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createCloudQaSlackActions } from '../src/qaSlack';
import type { Env } from '../src/env';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
describe('Cloudflare QA Slack project groups', () => {
  it('scopes projects and line labels to the same workspace and filters before the option limit', async () => {
    const db = new DatabaseSync(':memory:'); databases.push(db);
    db.exec(`CREATE TABLE product_lines(id TEXT PRIMARY KEY,workspace_id TEXT,name TEXT,icon TEXT,sort_order INTEGER);
      CREATE TABLE projects(id TEXT PRIMARY KEY,workspace_id TEXT,name TEXT,line_id TEXT,is_archived INTEGER);
      INSERT INTO product_lines VALUES ('la','a','Line A','A',2),('la0','a','Earlier A','',1),('lb','b','Secret B','',0);
      INSERT INTO projects VALUES ('a1','a','Zebra one','la',0),('a2','a','Zebra two','la0',0),('a3','a','Zebra archived','la',1),('a4','a','Zebra orphan','lb',0),('b1','b','Zebra secret','lb',0);`);
    for (let i = 0; i < 105; i++) db.prepare('INSERT INTO projects VALUES (?,?,?,?,0)').run(`other-${i}`, 'a', `Aardvark ${i}`, 'la');
    const env = { DB: { prepare: (sql: string) => ({
      bind: (...values: string[]) => ({ all: async () => ({ results: db.prepare(sql).all(...values) }) }),
    }) } } as unknown as Env;
    const actions = createCloudQaSlackActions(env, 'a', { waitUntil: (): void => {} });
    const actor = { id: 'member-a', role: 'member' as const, team: 'T', slack_user: 'U' };
    const groups = await actions.projects(actor, 'Zebra');
    expect(groups.map(group => group.line?.name ?? 'Other')).toEqual(['Earlier A', 'Line A', 'Other']);
    expect(groups.flatMap(group => group.projects.map(project => project.id))).toEqual(['a2', 'a1', 'a4']);
    expect(JSON.stringify(groups)).not.toContain('Secret B');
    expect((await actions.projects(actor, '')).flatMap(group => group.projects)).toHaveLength(100);
    expect(await actions.projects(actor, 'missing')).toEqual([]);
    const historyGroups=await actions.projects(actor,'Zebra',true);
    expect(historyGroups.flatMap(group=>group.projects.map(project=>project.id))).toEqual(['a2','a3','a1','a4']);
    expect(JSON.stringify(historyGroups)).not.toContain('Secret B');
    expect((await actions.projects(actor,'Zebra')).flatMap(group=>group.projects.map(project=>project.id))).not.toContain('a3');
  });
});
