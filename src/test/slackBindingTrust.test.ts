// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { deliveryStore } from '../../docker/volumes/functions/slack-deliver/backend';
import { releaseDeliveryStore } from '../../docker/volumes/functions/slack-deliver/release-backend';
import { trustedAdminBinding, Database } from '../../docker/volumes/functions/slack-interact/backend';
import { handleSlackActionsConfig } from '../../docker/volumes/functions/slack-actions-config/handler';

const env = { get: (key: string) => key === 'SUPABASE_URL' ? 'https://db.example.com' : 'example' };
type Row = Record<string, unknown>;
const owner = { id: 'member-owner', role: 'super_admin', is_active: true };
/** A PostgREST fake that honours the eq./in. filters these stores send. */
function database(tables: Record<string, Row[]>) {
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input)), table = url.pathname.split('/').pop()!;
    const rows = (tables[table] || []).filter(row => [...url.searchParams].every(([key, value]) => {
      if (['select', 'limit', 'order'].includes(key)) return true;
      if (value.startsWith('eq.')) return String(row[key]) === value.slice(3);
      if (value.startsWith('in.(')) return value.slice(4, -1).split(',').includes(String(row[key]));
      return true;
    }));
    return Response.json(rows.slice(0, Number(url.searchParams.get('limit') || rows.length)));
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
afterEach(() => vi.unstubAllGlobals());
const binding = (extra: Row) => ({ member_id: 'member-example', platform: 'slack', platform_team_id: 'TEXAMPLE',
  platform_user_id: 'UEXAMPLE', is_verified: true, verified_by: 'email', ...extra });

describe('manual Slack mappings need an active owner as issuer', () => {
  it.each([
    ['email binding', binding({}), [owner], 'UEXAMPLE'],
    ['owner-made mapping', binding({ verified_by: 'admin', verified_by_member_id: owner.id }), [owner], 'UEXAMPLE'],
    ['legacy mapping without issuer', binding({ verified_by: 'admin' }), [owner], undefined],
    ['plain-admin mapping', binding({ verified_by: 'admin', verified_by_member_id: 'member-admin' }), [owner, { id: 'member-admin', role: 'admin', is_active: true }], undefined],
    ['mapping by a deactivated owner', binding({ verified_by: 'admin', verified_by_member_id: owner.id }), [{ ...owner, is_active: false }], undefined],
  ])('personal delivery resolves the recipient for %s accordingly', async (_label, row, issuers, expected) => {
    database({ members: [{ id: 'member-example', auth_id: 'auth-example', role: 'member', is_active: true }, ...issuers], external_account_bindings: [row] });
    expect(await deliveryStore(env).binding('member-example', 'TEXAMPLE')).toBe(expected);
  });

  it('never trusts an issuer id that is not a plain identifier', async () => {
    const fetcher = database({ members: [owner] });
    expect(await trustedAdminBinding(new Database(env), binding({ verified_by: 'admin', verified_by_member_id: 'x,role.neq.super_admin' }))).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['owner-made', owner.id, [owner], true],
    ['plain-admin', 'member-admin', [{ id: 'member-admin', role: 'admin', is_active: true }], false],
  ])('release publication uses a %s mapping only when trusted', async (_label, issuer, issuers, published) => {
    const publication = { workspace_id: 'default', batch_id: 'batch-1', binding_id: 'binding-1', published_by: 'member-example',
      team_id: 'TEXAMPLE', channel_id: 'CEXAMPLE' };
    database({
      release_publications: [publication],
      release_batches: [{ workspace_id: 'default', id: 'batch-1', data: { ownerId: 'member-example', version: 1, components: [{ projectId: 'project-1' }] } }],
      release_events: [{ workspace_id: 'default', id: 'event-1', operation: 'create', version: 1, revision: 1 }],
      external_account_bindings: [binding({ id: 'binding-1', verified_by: 'admin', verified_by_member_id: issuer })],
      projects: [{ id: 'project-1', name: 'Example', line_id: 'line-1', is_archived: false }],
      members: [{ id: 'member-example', name: 'Example member', role: 'member', is_active: true }, ...issuers],
    });
    const state = await releaseDeliveryStore(env).snapshot({ id: 'job-1', event_id: 'event-1', batch_id: 'batch-1', workspace_id: 'default', attempts: 0 });
    expect(state?.publisherUser).toBe(published ? 'UEXAMPLE' : undefined);
    if (!published) expect(state).toBeUndefined();
  });

  it('suspends untrusted mappings in the database for every SQL identity check', () => {
    const sql = readFileSync(new URL('../../supabase/migrations/20261017_slack_admin_binding_issuer.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/UPDATE public\.external_account_bindings SET is_verified=false, reconfirm_required=true\s+WHERE platform='slack'/);
    expect(sql).toContain("issuer.role='super_admin' AND issuer.is_active");
    expect(sql).toMatch(/AFTER UPDATE OF role, is_active OR DELETE ON public\.members/);
  });
});

describe('Slack settings for account mappings', () => {
  const people = [{ id: 'member-owner', name: 'Example Owner', role: 'super_admin', is_active: true, auth_id: 'auth-owner' },
    { id: 'member-admin', name: 'Example Admin', role: 'admin', is_active: true, auth_id: 'auth-admin' },
    { id: 'member-example', name: 'Example Member', role: 'member', is_active: true, auth_id: 'auth-member' }];
  function config(caller: string, bindings: Row[] = []) {
    const writes: { url: URL; method: string; body: Row }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)), table = url.pathname.split('/').pop()!;
      if (url.hostname === 'slack.com') return Response.json({ ok: true, members: [{ id: 'UPERSON', name: 'person', profile: { email: 'person@example.org' } }] });
      if (url.pathname === '/auth/v1/user') return Response.json({ id: caller });
      if (init?.method && init.method !== 'GET') { writes.push({ url, method: init.method, body: JSON.parse(String(init.body)) }); return Response.json([]); }
      if (table === 'system_settings') return Response.json([{ value: url.searchParams.get('key') === 'eq.feature_toggles' ? { slackActions: true } : null }]);
      if (table === 'slack_config') return Response.json([{ bot_token: 'example-bot' }]);
      if (table === 'members') {
        const auth = url.searchParams.get('auth_id')?.slice(3), ids = url.searchParams.get('id')?.slice(4, -1).split(',');
        return Response.json(people.filter(p => (!auth || p.auth_id === auth) && (!ids || ids.includes(p.id))));
      }
      if (table === 'external_account_bindings') {
        expect(url.searchParams.get('or')).toBe('(is_verified.eq.true,reconfirm_required.eq.true)');
        // The settings page hides Slack accounts that already have a working mapping.
        expect(url.searchParams.get('select')?.split(',')).toEqual(expect.arrayContaining(['member_id', 'platform_user_id', 'is_verified', 'reconfirm_required']));
        return Response.json(bindings);
      }
      return Response.json([]);
    }));
    return writes;
  }
  const request = (query = '', body?: Row) => new Request(`https://example.com/functions/v1/slack-actions-config${query}`,
    { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer member-session' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  it('keeps listing suspended mappings so an owner sees they need to be mapped again', async () => {
    config('auth-admin', [
      { id: 'b-owner', member_id: 'member-example', display_name: 'trusted', verified_by: 'admin', verified_by_member_id: 'member-owner', is_verified: true, reconfirm_required: false },
      { id: 'b-plain', member_id: 'member-example', display_name: 'suspended', verified_by: 'admin', verified_by_member_id: 'member-admin', is_verified: false, reconfirm_required: true },
      { id: 'b-stale', member_id: 'member-example', display_name: 'stale', verified_by: 'admin', verified_by_member_id: 'member-owner', is_verified: false, reconfirm_required: true },
    ]);
    const body = await (await handleSlackActionsConfig(request(), env)).json();
    expect(body.bindings.map((b: Row) => [b.id, b.verifiedByOwner])).toEqual([['b-owner', true], ['b-plain', false], ['b-stale', false]]);
  });
  it('unbinding clears the reconfirm hint as well as verification', async () => {
    const writes = config('auth-owner');
    expect((await handleSlackActionsConfig(request('', { action: 'unbind', id: '00000000-0000-4000-8000-000000000001' }), env)).status).toBe(200);
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toEqual({ is_verified: false, reconfirm_required: false });
  });
});
