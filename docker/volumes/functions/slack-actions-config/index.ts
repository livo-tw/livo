import { Database } from '../slack-interact/backend.ts';
import { enabled } from '../slack-interact/core.ts';
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers });
  try {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!jwt) return json({ error: 'unauthorized' }, 401);
    const admin = new Database(Deno.env), userDb = new Database(Deno.env, jwt);
    const auth = await userDb.request('/auth/v1/user');
    const member = (await admin.rows('members', { select: 'id,role,is_active', auth_id: `eq.${auth.id}`, limit: '1' }))[0];
    if (!member?.is_active || !['admin', 'super_admin'].includes(member.role)) return json({ error: 'forbidden' }, 403);
    if (!enabled(await admin.setting('feature_toggles'))) return json({ error: 'disabled' }, 403);
    if (req.method === 'GET') {
      const heartbeat = await admin.setting('slack_socket_status');
      const bindings = await admin.rows('external_account_bindings', { select: 'id,member_id,display_name,bound_at',
        platform: 'eq.slack', is_verified: 'eq.true', order: 'bound_at.desc' });
      const ids = bindings.map(b => b.member_id);
      const members = ids.length ? await admin.rows('members', { select: 'id,name,is_active', id: `in.(${ids.join(',')})` }) : [];
      return json({ connected: heartbeat?.connected === true && Date.now() - Date.parse(heartbeat.at) < 90000,
        lastSeen: heartbeat?.at || null, bindings: bindings.map(b => ({ ...b, memberName: members.find(m => m.id === b.member_id)?.name || '',
          active: members.find(m => m.id === b.member_id)?.is_active === true })) });
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const body = await req.json();
    if (body.action !== 'unbind' || !/^[\da-f-]{36}$/i.test(body.id)) return json({ error: 'invalid_request' }, 400);
    // Retain audit log foreign keys. The next invocation must verify email again.
    await admin.write('external_account_bindings', { is_verified: false }, { id: `eq.${body.id}`, platform: 'eq.slack' }, 'PATCH');
    return json({ ok: true });
  } catch { return json({ error: 'request_failed' }, 500); }
});
