// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runQuery } from '../src/db';
import type { QueryRequest } from '../src/protocol';
import { backendAccessFixture } from './backendAccessFixture';

describe('notification recipient read permissions', () => {
  let fixture: ReturnType<typeof backendAccessFixture>;
  beforeEach(() => { fixture = backendAccessFixture(); });
  afterEach(() => fixture.db.close());
  const query = (id: string, extra: Partial<QueryRequest> = {}) => runQuery(fixture.env, { waitUntil() {} }, fixture.auth(id), {
    table: 'notifications', op: 'select', ...extra,
  });

  it.each(['member', 'admin'])('limits %s to its own inbox without any client filter', async id => {
    const result = await query(id);
    expect(result.error).toBeNull();
    expect((result.data as Array<{ id: string }>).map(row => row.id)).toEqual([`notice-${id}`]);
  });

  it.each(['member', 'admin'])('does not let %s broaden a read with another recipient or a count', async id => {
    const result = await query(id, { count: 'exact', head: true, filters: [{ col: 'recipient_id', op: 'eq', val: 'other' }] });
    expect(result.error).toBeNull();
    expect(result.count).toBe(0);
  });

  it('preserves the super-admin full backup within its workspace', async () => {
    const result = await query('super');
    expect(result.error).toBeNull();
    expect((result.data as Array<{ id: string }>).map(row => row.id).sort()).toEqual(['notice-admin', 'notice-member', 'notice-other', 'notice-super']);
  });

  it('does not use a cached super-admin role after demotion', async () => {
    fixture.db.exec("UPDATE members SET role='admin' WHERE id='super'");
    const result = await query('super');
    expect(result.error).toBeNull();
    expect((result.data as Array<{ id: string }>).map(row => row.id)).toEqual(['notice-super']);
  });

  it.each(["UPDATE members SET is_active=0 WHERE id='member'", "UPDATE members SET auth_id=NULL WHERE id='member'", "UPDATE auth_users SET banned=1 WHERE id='login-member'"])(
    'rejects a stale inbox identity after %s', async sql => {
      fixture.db.exec(sql);
      expect((await query('member')).error?.code).toBe('42501');
    },
  );

  it('does not grant a recipient permission to re-address a notice', async () => {
    const result = await runQuery(fixture.env, { waitUntil() {} }, fixture.auth('member'), {
      table: 'notifications', op: 'update', values: { recipient_id: 'other' }, filters: [{ col: 'id', op: 'eq', val: 'notice-member' }],
    });
    expect(result.error?.code).toBe('42501');
  });
});
