import { describe, it, expect, beforeEach } from 'vitest';
import { createMockClient } from './mockClient';

// The in-memory client behind ?demo=pro. Filters must behave like PostgREST /
// the D1 worker (SQL NULL semantics), and every filter the app calls must exist.

const db = createMockClient();
const T = 'mock_client_test'; // scratch table, not part of the seeded schema
const MID = '2026-03-01T00:00:00.000Z';
const ROWS = [
  { id: 'a', n: 1,    at: '2026-01-01T00:00:00.000Z', project_id: 'p1', flag: true },
  { id: 'b', n: 2,    at: '2026-06-01T00:00:00.000Z', project_id: null, flag: false },
  { id: 'c', n: null, at: null,                       project_id: 'p2', flag: null },
];

const ids = (res: { data: unknown }) => (res.data as { id: string }[]).map(r => r.id).sort();
const select = () => db.from(T).select('*');

beforeEach(async () => {
  await db.from(T).delete().not('id', 'is', null);
  await db.from(T).insert(ROWS);
});

describe('mockClient filters', () => {
  it('keeps approvals enabled in the isolated demo data', async () => {
    const result = await db.from('system_settings').select('value').eq('key', 'feature_toggles').single();
    expect(result.data).toMatchObject({ value: { approvals: true } });
  });
  it('gt / gte / lt / lte compare numbers and never match NULL', async () => {
    expect(ids(await select().gt('n', 1))).toEqual(['b']);
    expect(ids(await select().gte('n', 1))).toEqual(['a', 'b']);
    expect(ids(await select().lt('n', 2))).toEqual(['a']);
    expect(ids(await select().lte('n', 2))).toEqual(['a', 'b']);
  });

  it('gt / lt order ISO timestamps chronologically', async () => {
    expect(ids(await select().gt('at', MID))).toEqual(['b']);
    expect(ids(await select().lt('at', MID))).toEqual(['a']);
  });

  it('neq skips NULL like SQL <>', async () => {
    expect(ids(await select().neq('project_id', 'p1'))).toEqual(['c']);
  });

  it('is matches NULL and booleans', async () => {
    expect(ids(await select().is('project_id', null))).toEqual(['b']);
    expect(ids(await select().is('flag', true))).toEqual(['a']);
  });

  it('not negates any filter, NULL only matching not.is', async () => {
    expect(ids(await select().not('project_id', 'is', null))).toEqual(['a', 'c']);
    expect(ids(await select().not('project_id', 'eq', 'p1'))).toEqual(['c']);
    expect(ids(await select().not('id', 'in', ['a']))).toEqual(['b', 'c']);
  });

  it('or parses PostgREST expressions, reading values by column type', async () => {
    expect(ids(await select().or('project_id.eq.p1,project_id.is.null'))).toEqual(['a', 'b']);
    expect(ids(await select().or('n.gt.1,id.eq.c'))).toEqual(['b', 'c']);
    expect(ids(await select().or('flag.eq.true'))).toEqual(['a']);
  });

  it('rejects an or() condition it cannot evaluate instead of matching everything', async () => {
    await expect(select().or('n.like.1')).rejects.toThrow('unsupported or() condition');
  });

  it('update and delete take the same filters', async () => {
    // integrationQueries: update().eq().gt('expires_at', now)
    await db.from(T).update({ flag: false }).eq('id', 'a').gt('at', MID);
    expect(ids(await select().eq('flag', false))).toEqual(['b']);
    await db.from(T).update({ flag: false }).eq('id', 'a').gt('at', '2025-01-01T00:00:00.000Z');
    expect(ids(await select().eq('flag', false))).toEqual(['a', 'b']);

    // AdminUsageSection: delete().lt('created_at', cutoff) keeps NULL rows
    await db.from(T).delete().lt('at', MID);
    expect(ids(await select())).toEqual(['b', 'c']);

    // AdminBackupSection: delete().neq('id', sentinel) clears the table
    await db.from(T).delete().neq('id', '___none___');
    expect(ids(await select())).toEqual([]);
  });
});

describe('mockClient results', () => {
  it('then() returns a promise, so .then().catch() chains (NotificationPanel)', async () => {
    const marked = db.from(T).update({ flag: true }).eq('id', 'b')
      .then(({ error }) => error)
      .catch(() => 'rejected');
    await expect(marked).resolves.toBeNull();
    expect(ids(await select().is('flag', true))).toEqual(['a', 'b']);
  });

  it('update().select().single() resolves with the updated row (approval workflow)', async () => {
    const res = await db.from(T).update({ n: 5 }).eq('id', 'a').eq('n', 1).select().single();
    expect(res.error).toBeNull();
    expect(res.data).toMatchObject({ id: 'a', n: 5 });
    // the optimistic lock no longer matches, so nothing is updated
    const stale = await db.from(T).update({ n: 6 }).eq('id', 'a').eq('n', 1).select().maybeSingle();
    expect(stale).toEqual({ data: null, error: null });
  });

  it('upsert().select().single() resolves with the written row (standups)', async () => {
    const res = await db.from(T).upsert({ id: 'd', n: 4 }).select().single();
    expect(res.data).toMatchObject({ id: 'd', n: 4 });
    expect(ids(await select().gte('n', 2))).toEqual(['b', 'd']);
  });
});

describe('mockClient upsert', () => {
  const U = 'mock_client_upsert_test'; // scratch table, emptied before each case
  const opts = { onConflict: 'member_id,view_key' };
  const all = async () => (await db.from(U).select('*')).data as Record<string, unknown>[];
  const list = () => db.from(U).select('*').eq('member_id', 'm-001').eq('view_key', 'list').maybeSingle();

  beforeEach(async () => {
    await db.from(U).delete().not('id', 'is', null);
  });

  it('onConflict columns update the matching row in place: same id, no duplicate (useColumnConfig)', async () => {
    const first = await db.from(U).upsert({ member_id: 'm-001', view_key: 'list', visible_keys: ['a'] }, opts).select().single();
    // a new row gets the same defaults as insert()
    expect(first.data).toMatchObject({ id: expect.any(String), created_at: expect.any(String) });
    const id = (first.data as { id: string }).id;
    await db.from(U).upsert({ member_id: 'm-001', view_key: 'board', visible_keys: ['b'] }, opts);

    const res = await db.from(U).upsert({ member_id: 'm-001', view_key: 'list', visible_keys: ['c'] }, opts).select().single();
    expect(res.data).toMatchObject({ id, visible_keys: ['c'] });
    expect(await all()).toHaveLength(2);
    expect((await list()).data).toMatchObject({ id, visible_keys: ['c'] });

    // a payload id doesn't replace the stored one (useTaskRelations sends one)
    await db.from(U).upsert({ id: 'other', member_id: 'm-001', view_key: 'list', visible_keys: ['d'] }, opts);
    expect(await all()).toHaveLength(2);
    expect((await list()).data).toMatchObject({ id, visible_keys: ['d'] });
  });

  it('defaults to id: a row with an id updates that row, one without is inserted with a new id', async () => {
    await db.from(U).insert({ id: 'x', name: 'old', note: 'kept' });
    await db.from(U).upsert({ id: 'x', name: 'new' });
    expect(await all()).toEqual([expect.objectContaining({ id: 'x', name: 'new', note: 'kept' })]);

    const res = await db.from(U).upsert({ name: 'second' }).select().single();
    const id = (res.data as { id: string }).id;
    expect(id).toEqual(expect.any(String));
    expect(id).not.toBe('x');
    expect(await all()).toHaveLength(2);
  });

  it('without onConflict, settings tables conflict on their key column (RequiredFieldsSettings)', async () => {
    const key = 'mock_client_test';
    await db.from('system_settings').upsert({ key, value: ['a'] });
    await db.from('system_settings').upsert({ key, value: ['b'] });
    const { data } = await db.from('system_settings').select('*').eq('key', key);
    expect(data).toEqual([expect.objectContaining({ key, value: ['b'] })]);
    await db.from('system_settings').delete().eq('key', key);
  });

  it('ignoreDuplicates leaves a conflicting row untouched and returns only the inserted ones', async () => {
    const ignore = { ...opts, ignoreDuplicates: true };
    await db.from(U).upsert({ member_id: 'm-001', view_key: 'list', visible_keys: ['a'] }, ignore);
    const res = await db.from(U).upsert([
      { member_id: 'm-001', view_key: 'list', visible_keys: ['changed'] },
      { member_id: 'm-002', view_key: 'list', visible_keys: ['b'] },
    ], ignore).select();
    expect(res.data).toEqual([expect.objectContaining({ member_id: 'm-002' })]);
    expect((await list()).data).toMatchObject({ visible_keys: ['a'] });
    expect(await all()).toHaveLength(2);
  });

  it('a NULL conflict column never matches, as in a SQL unique index', async () => {
    await db.from(U).upsert({ member_id: 'm-001', view_key: null }, opts);
    await db.from(U).upsert({ member_id: 'm-001', view_key: null }, opts);
    expect(await all()).toHaveLength(2);
  });
});
