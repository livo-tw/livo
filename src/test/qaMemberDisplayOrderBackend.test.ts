// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createQaService } from '../../docker/volumes/functions/qa/service';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));
const authId = '11111111-1111-4111-8111-111111111111';
const env = { get: (key: string) => ({ SUPABASE_URL: 'https://example.test', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' } as Record<string, string>)[key] };
let active: boolean, rpcDenied: boolean;
let rpcCalls: unknown[];
beforeEach(() => {
  active = true; rpcDenied = false; rpcCalls = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
    const url = new URL(input);
    if (url.pathname === '/auth/v1/user') return Response.json({ id: authId });
    if (url.pathname === '/rest/v1/members') {
      expect(url.searchParams.has('auth_id')).toBe(true);
      return Response.json([{ id: 'member-example', role: 'member', auth_id: authId, is_active: active }]);
    }
    if (url.pathname === '/rest/v1/system_settings') return Response.json([{ value: { qa: true } }]);
    if (url.pathname === '/rest/v1/projects') return Response.json([{ id: 'project-example' }]);
    if (url.pathname === '/rest/v1/qa_project_coordination') return Response.json([]);
    if (url.pathname.endsWith('/livo_qa_member_display_page')) {
      rpcCalls.push(JSON.parse(String(init.body)));
      return rpcDenied ? Response.json({ code: '42501', message: 'qa_forbidden' }, { status: 403 })
        : Response.json({ members: [{ id: 'eqa-looking-internal', name: 'Example member', sortOrder: 99, isExternal: false }], hasMore: false });
    }
    throw new Error('Unexpected endpoint');
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('QA internal display page', () => {
  it('uses the verified caller and exact search/page scope without fetching an unordered raw directory', async () => {
    const result = await createQaService(env, 'example-session').handle({ action: 'members', projectId: 'project-example', search: ' %_ ', offset: 100, authId: 'spoofed', workspaceId: 'other' });
    expect(rpcCalls).toEqual([{ p_auth_id: authId, p_project_id: 'project-example', p_search: '%_', p_offset: 100 }]);
    expect(result).toEqual({ members: [{ id: 'eqa-looking-internal', name: 'Example member', sortOrder: 99, isExternal: false }], hasMore: false });
  });
  it('rejects inactive callers and preserves a fresh database denial', async () => {
    active = false;
    await expect(createQaService(env, 'example-session').handle({ action: 'members', projectId: 'project-example' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(rpcCalls).toEqual([]);
    active = true; rpcDenied = true;
    await expect(createQaService(env, 'example-session').handle({ action: 'members', projectId: 'project-example' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  });
  it('runs the Cloud query on SQLite with mixed ranks, a null fallback, inactive and foreign-tenant rows across 100 results', () => {
    const source = readFileSync(new URL('../../worker/src/qa.ts', import.meta.url), 'utf8');
    const match = source.match(/prepare\('(SELECT id,name,COALESCE\(sort_order,99\) AS sortOrder FROM members[^']+LIMIT 101 OFFSET \?)'\)/);
    expect(match).not.toBeNull();
    const program = `import json,sqlite3,sys
sql=json.load(sys.stdin)['sql']; db=sqlite3.connect(':memory:'); db.row_factory=sqlite3.Row
db.execute('CREATE TABLE members(workspace_id TEXT,id TEXT,name TEXT,sort_order INTEGER,is_active INTEGER)')
rows=[('one','tie-b','Alpha',1,1),('one','tie-a','Zulu',1,1),('one','null-rank','Null',None,1),('one','late','Late',100,1),('one','inactive','Inactive',0,0),('other','foreign','Foreign',0,1)]
rows += [('one','page-%03d'%i,'Reverse %03d'%(121-i),i+10,1) for i in range(120)]
db.executemany('INSERT INTO members VALUES(?,?,?,?,?)',rows)
first=[dict(x) for x in db.execute(sql,('one','',0))]; second=[dict(x) for x in db.execute(sql,('one','',100))]
allrows=first[:100]+second; ids=[x['id'] for x in allrows]
assert len(first)==101 and len(allrows)==124 and len(set(ids))==124
assert ids[:2]==['tie-a','tie-b'] and ids.index('null-rank')<ids.index('late')
assert 'inactive' not in ids and 'foreign' not in ids
assert all(set(x)=={'id','name','sortOrder'} for x in allrows)
assert next(x for x in allrows if x['id']=='null-rank')['sortOrder']==99
print(json.dumps({'passed':True,'count':len(allrows)}))`;
    const output = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', program], { input: JSON.stringify({ sql: match![1] }), encoding: 'utf8', timeout: 10000, windowsHide: true });
    expect(JSON.parse(output)).toEqual({ passed: true, count: 124 });
  });
});
