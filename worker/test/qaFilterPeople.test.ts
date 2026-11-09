// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { executeQaAction } from '../src/qa';
import type { AuthCtx, Env } from '../src/env';

const authId = '11111111-1111-4111-8111-111111111111';
function cloudFixture(active = true) {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const DB = { prepare: (sql: string) => ({ bind: (...params: unknown[]) => ({ first: async (): Promise<unknown> => {
    queries.push({ sql, params });
    if (sql.includes("key='feature_toggles'")) return { value: JSON.stringify({ qa: true }) };
    if (sql.startsWith('SELECT id,is_qa_admin FROM members')) return active ? { id: 'member-example', is_qa_admin: 0 } : null;
    throw new Error('Unexpected cloud query');
  } }) }) };
  const auth: AuthCtx = { userId: authId, email: 'member@example.com',
    member: { id: 'member-example', role: 'member', email: 'member@example.com', name: 'Example member', workspaceId: 'workspace-example' } };
  return { env: { DB } as unknown as Env, auth, queries };
}

describe('Cloud QA filter compatibility', () => {
  it('returns no external identities after normal workspace and active-member checks', async () => {
    const fixture = cloudFixture();
    expect(await executeQaAction(fixture.env, fixture.auth, { action: 'filter_people', projectIds: ['project-example'], offset: 100 }))
      .toEqual({ members: [], hasMore: false });
    expect(fixture.queries).toHaveLength(2);
    expect(fixture.queries.every(query => query.params[0] === 'workspace-example')).toBe(true);
    expect(fixture.queries[1].params).toEqual(['workspace-example', 'member-example', 'member']);
  });
  it('still rejects an inactive Cloud member', async () => {
    const fixture = cloudFixture(false);
    await expect(executeQaAction(fixture.env, fixture.auth, { action: 'filter_people' })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  });
  it('validates the same filter scope shape on Cloud', async () => {
    const fixture = cloudFixture();
    await expect(executeQaAction(fixture.env, fixture.auth, { action: 'filter_people', projectIds: ['project-example', 'project-example'] }))
      .rejects.toMatchObject({ code: 'qa_invalid_request', status: 400 });
  });
});
