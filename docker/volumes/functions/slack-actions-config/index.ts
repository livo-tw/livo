import { Database, slackClient } from '../slack-interact/backend.ts';
import { canAssignSlackMember, enabled, SLACK_USER_ID, slackEmailBelongsToOther } from '../slack-interact/core.ts';
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
    const member = (await admin.rows('members', { select: 'id,name,role,is_active', auth_id: `eq.${auth.id}`, limit: '1' }))[0];
    if (!member?.is_active || !['admin', 'super_admin'].includes(member.role)) return json({ error: 'forbidden' }, 403);
    if (!enabled(await admin.setting('feature_toggles'))) return json({ error: 'disabled' }, 403);
    const slack = slackClient(Deno.env, admin);
    if (req.method === 'GET') {
      if (new URL(req.url).searchParams.get('slackUsers') === '1') {
        // Workspace people an admin can assign (users:read and users:read.email).
        const users: { id: string; name: string; email: string }[] = [];
        let cursor = '';
        for (let page = 0; page < 10; page++) {
          const list = await slack('users.list', { limit: '200', ...(cursor ? { cursor } : {}) });
          for (const u of list.members || []) {
            if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue;
            users.push({ id: u.id, name: u.profile?.display_name || u.real_name || u.name || u.id, email: u.profile?.email || '' });
          }
          cursor = list.response_metadata?.next_cursor || '';
          if (!cursor) break;
        }
        return json({ users: users.sort((a, b) => a.name.localeCompare(b.name)) });
      }
      const heartbeat = await admin.setting('slack_socket_status');
      const bindings = await admin.rows('external_account_bindings', { select: 'id,member_id,display_name,bound_at,verified_by',
        platform: 'eq.slack', is_verified: 'eq.true', order: 'bound_at.desc' });
      const ids = bindings.map(b => b.member_id);
      const members = ids.length ? await admin.rows('members', { select: 'id,name,is_active', id: `in.(${ids.join(',')})` }) : [];
      return json({ connected: heartbeat?.connected === true && Date.now() - Date.parse(heartbeat.at) < 90000,
        lastSeen: heartbeat?.at || null, bindings: bindings.map(b => ({ ...b, verifiedBy: b.verified_by || 'email',
          memberName: members.find(m => m.id === b.member_id)?.name || '',
          active: members.find(m => m.id === b.member_id)?.is_active === true })) });
    }
    if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const body = await req.json();
    if (body.action === 'bind') {
      // An admin assigns a Slack user to a member whose LIVO email differs.
      if (typeof body.memberId !== 'string' || !body.memberId || body.memberId.length > 100 ||
        typeof body.slackUserId !== 'string' || !SLACK_USER_ID.test(body.slackUserId)) return json({ error: 'invalid_request' }, 400);
      const target = (await admin.rows('members', { select: 'id,name,role,is_active,auth_id', id: `eq.${body.memberId}`, limit: '1' }))[0];
      if (!canAssignSlackMember(member, target)) return json({ error: 'member_not_assignable' }, 403);
      const team = (await slack('auth.test', {})).team_id;
      const info = (await slack('users.info', { user: body.slackUserId })).user;
      if (!team || !info || info.deleted || info.is_bot || (info.team_id && info.team_id !== team))
        return json({ error: 'slack_user_unavailable' }, 400);
      const slackEmail = info.profile?.email;
      if (typeof slackEmail === 'string' && slackEmail.trim()) {
        const pattern = slackEmail.trim().replace(/[\\%_]/g, (c: string) => '\\' + c);
        const owners = await admin.rows('members', { select: 'id,email', email: `ilike.${pattern}`, limit: '5' });
        if (slackEmailBelongsToOther(owners, slackEmail, target.id)) return json({ error: 'slack_user_belongs_to_other' }, 409);
      }
      const name = info.profile?.display_name || info.real_name || info.name || info.id;
      await admin.write('external_account_bindings', { member_id: target.id, platform: 'slack', platform_user_id: info.id,
        platform_team_id: team, display_name: name, is_verified: true, verified_by: 'admin' },
        { on_conflict: 'platform,platform_user_id,platform_team_id' });
      await admin.write('activity_logs', { user_id: member.id, action: 'slack_bind', target_type: 'system',
        detail: `[Slack] ${name} → ${target.name}` });
      // Tell the member, so a mapping they did not expect is noticed right away.
      if (target.id !== member.id) await admin.write('notifications', { recipient_id: target.id, sender_id: member.id,
        type: 'system', task_id: '', content: `${member.name} 已將 Slack 帳號「${name}」對應到你的 LIVO 帳號；若不是你本人，請立即告知管理員。`, is_read: false });
      return json({ ok: true });
    }
    if (body.action !== 'unbind' || !/^[\da-f-]{36}$/i.test(body.id)) return json({ error: 'invalid_request' }, 400);
    // Retain audit log foreign keys. The next invocation must verify email again.
    await admin.write('external_account_bindings', { is_verified: false }, { id: `eq.${body.id}`, platform: 'eq.slack' }, 'PATCH');
    return json({ ok: true });
  } catch { return json({ error: 'request_failed' }, 500); }
});
