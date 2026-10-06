import { parseDeploymentEnvironments } from './qa/environments';
import { groupProjectsByLine } from './qa/projectGroups';
import type { Context } from 'hono';
import { isDemoMember, type AppContext, type AuthCtx, type Ctx, type Env } from './env';
import { executeQaAction, deploymentQueueOperator } from './qa';
import { drainQaSlackInbox, handleQaSlack, isQaSlackPayload, qaRequestId, qaSlackCard, type QaSlackActions, type QaSlackActor, type QaSlackPayload } from './qa/slack';
import { qaSlackClient, qaSlackEnabled, qaSlackLink, syncQaSlackIssue, getQaSlackWorkflow } from './qaSlackSync';
import { cleanupQaExpiredUploads } from './qaStorage';
import { handleKnowledgeSlack, isKnowledgeSlackPayload } from './knowledgeSlackCore';
import { slackLinkDisabled } from './slackLink';
import { createCloudKnowledgeSlackActions } from './knowledgeSlack';

export async function verifyQaSlackSignature(secret: string | undefined, timestamp: string | null, signature: string | null, body: string, now = Date.now()): Promise<boolean> {
  if (!secret || !timestamp || !/^\d+$/.test(timestamp) || !signature || !/^v0=[a-f0-9]{64}$/.test(signature) || Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${timestamp}:${body}`)));
  const expected = 'v0=' + [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  let difference = 0; for (let i = 0; i < expected.length; i++) difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return difference === 0;
}
type Actor = QaSlackActor & { auth: AuthCtx };
async function claimInbox(env:Env,ws:string,id:string):Promise<{id:string;payload:QaSlackPayload}|undefined>{
  const now=new Date().toISOString();
  const current=await env.DB.prepare("SELECT attempts FROM qa_slack_inbox WHERE workspace_id=? AND id=? AND state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) AND expires_at>?").bind(ws,id,now,now,now).first<{attempts:number}>();
  if(!current)return;
  const delay=Math.min(3600,60*2**Math.min(current.attempts,6))*1000;
  const claimed=await env.DB.prepare("UPDATE qa_slack_inbox SET attempts=attempts+1,lease_until=?,next_attempt_at=? WHERE workspace_id=? AND id=? AND state='pending' AND attempts=? AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) AND expires_at>? RETURNING id,payload")
    .bind(new Date(Date.now()+90000).toISOString(),new Date(Date.now()+delay).toISOString(),ws,id,current.attempts,now,now,now).first<{id:string;payload:string}>();
  return claimed?{id:claimed.id,payload:JSON.parse(claimed.payload) as QaSlackPayload}:undefined;
}
export function createCloudQaSlackActions(env: Env, ws: string, ctx: Ctx): QaSlackActions {
  const slack = qaSlackClient(env, ws);
  let teamIdentity:Promise<string>|undefined;
  const configuredTeam=()=>teamIdentity??=(async()=>String((await slack('auth.test',{})).team_id||''))();
  const adapter: QaSlackActions = {
    enabled: () => qaSlackEnabled(env, ws),
    actor: async p => {
      const team = p.team_id || p.team?.id, user = p.user_id || p.user?.id || p.event?.user;
      if (!team || !user || await configuredTeam() !== team) throw new Error('qa_forbidden');
      const profile = (await slack('users.info', { user, include_locale: true })).user;
      if (!profile || profile.deleted || profile.is_bot || profile.is_restricted || profile.is_ultra_restricted || profile.team_id !== team || typeof profile.profile?.email !== 'string') throw new Error('qa_forbidden');
      // A client-editable legacy binding is not proof of identity. Verified Slack email
      // must uniquely match an active member and its live, non-banned auth account.
      const members = await env.DB.prepare('SELECT m.id,m.name,m.role,m.email,m.auth_id FROM members m JOIN auth_users a ON a.id=m.auth_id AND a.banned=0 WHERE m.workspace_id=? AND m.is_active=1 AND m.email=? COLLATE NOCASE AND a.email=m.email COLLATE NOCASE LIMIT 2')
        .bind(ws, profile.profile.email.trim()).all<{id:string;name:string;role:string;email:string;auth_id:string}>();
      if (members.results.length !== 1) throw new Error('qa_forbidden');
      const member = members.results[0], auth: AuthCtx = { userId: member.auth_id, email: member.email, member: { ...member, workspaceId: ws } };
      if (isDemoMember(env, auth)) throw new Error('qa_forbidden');
      // The member turned Slack linking off in My settings.
      if (await slackLinkDisabled(env, ws, member.id)) throw new Error('slack_link_disabled');
      return { id: member.id, role: member.role, team, slack_user: user, locale: profile.locale, deploymentOperator: await deploymentQueueOperator(env, auth), auth } as Actor;
    },
    api: async <T>(actor: QaSlackActor, body: Record<string, unknown>) => {
      if (!await qaSlackEnabled(env, ws)) throw new Error('qa_disabled');
      return await executeQaAction(env, (actor as Actor).auth, body, ctx) as T;
    },
    environments: async () => {
      const row = await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='deployment_environments'").bind(ws).first<{value:string}>();
      const parsed = parseDeploymentEnvironments(row ? JSON.parse(row.value) : undefined);
      if (!parsed) throw new Error('qa_invalid_environment');
      return parsed.values;
    },
    projects: async (_actor, search, includeArchived = false) => {
      const [rows, lines] = await Promise.all([
        env.DB.prepare(`SELECT id,name,line_id FROM projects WHERE workspace_id=? ${includeArchived ? '' : 'AND is_archived=0'} AND instr(lower(name),lower(?))>0 ORDER BY name,id LIMIT 100`).bind(ws, search).all<{id:string;name:string;line_id:string}>(),
        env.DB.prepare('SELECT id,name,icon FROM product_lines WHERE workspace_id=? ORDER BY sort_order,id').bind(ws).all<{id:string;name:string;icon:string}>(),
      ]);
      return groupProjectsByLine(lines.results, rows.results.map(project => ({ ...project, lineId: project.line_id })));
    },
    mapped: async (actor, source) => {
      if (!source.thread || source.team !== actor.team) return undefined;
      return (await env.DB.prepare('SELECT issue_id FROM qa_slack_links WHERE workspace_id=? AND team_id=? AND channel_id=? AND thread_ts=?').bind(ws, actor.team, source.channel, source.thread).first<{issue_id:string}>())?.issue_id;
    },
    publish: async (actor, issue, source) => {
      let channel = source.channel;
      if (!channel) channel = (await slack('conversations.open', { users: actor.slack_user })).channel.id;
      const existing = source.thread ? await adapter.mapped(actor, { ...source, channel, team: actor.team }) : undefined;
      if (existing && existing !== issue.id) throw new Error('此訊息串已綁定另一張 Bug。');
      if (existing) { await syncQaSlackIssue(env, ws, issue); return; }
      const id = await qaRequestId(`${ws}:${actor.team}:${channel}:${source.thread || issue.id}:${issue.id}`);
      const hex = id.slice(9,41), clientId = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      const card = await slack('chat.postMessage', { channel, ...(source.thread ? {thread_ts:source.thread} : {}), client_msg_id: clientId,
        text: `Bug · ${issue.title}`, blocks: qaSlackCard(issue, qaSlackLink(env, issue), await getQaSlackWorkflow(env,ws)) });
      await env.DB.prepare('INSERT INTO qa_slack_links(id,workspace_id,issue_id,team_id,channel_id,thread_ts,card_ts,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .bind(id, ws, issue.id, actor.team, channel, source.thread || card.ts, card.ts, new Date().toISOString()).run();
    },
    sync: (_actor, issue) => syncQaSlackIssue(env, ws, issue),
    claimNotice: async key => { const result = await env.DB.prepare('INSERT OR IGNORE INTO qa_slack_receipts(id,workspace_id,created_at) VALUES(?,?,?)').bind(`${ws}:${key}`,ws,new Date().toISOString()).run(); return result.meta.changes === 1; },
    enqueueEvent: async p => {
      if(!await qaSlackEnabled(env,ws))return '';
      const event=p.event;
      if(!event||event.type!=='message'||!event.user||!event.channel||!event.ts||!event.thread_ts||!event.text||event.text.length>40000)throw new Error('qa_invalid_slack_event');
      const mapped=await env.DB.prepare('SELECT id FROM qa_slack_links WHERE workspace_id=? AND team_id=? AND channel_id=? AND thread_ts=?').bind(ws,p.team_id||p.team?.id||'',event.channel,event.thread_ts).first();
      if(!mapped)return ''; // Do not retain ordinary Slack conversations outside linked QA threads.
      if(await configuredTeam()!==(p.team_id||p.team?.id))throw new Error('qa_forbidden');
      const id=p.event_id||await qaRequestId(`${p.team_id||p.team?.id}:${event.channel}:${event.ts}`),now=new Date().toISOString();
      const payload:QaSlackPayload={type:'event_callback',event_id:id,team_id:p.team_id||p.team?.id,event:{type:'message',user:event.user,channel:event.channel,ts:event.ts,thread_ts:event.thread_ts,text:event.text}};
      await env.DB.prepare("INSERT OR IGNORE INTO qa_slack_inbox(workspace_id,id,payload,next_attempt_at,created_at,expires_at) VALUES(?,?,?,?,?,?)")
        .bind(ws,id,JSON.stringify(payload),now,now,new Date(Date.now()+30*86400000).toISOString()).run();
      return (await claimInbox(env,ws,id))?.id||'';
    },
    completeEvent: async id => {
      await env.DB.prepare("UPDATE qa_slack_inbox SET state='done',lease_until=NULL WHERE workspace_id=? AND id=? AND state='pending'").bind(ws,id).run();
    },
    pendingEvents: async () => {
      const now=new Date().toISOString();
      await env.DB.prepare('DELETE FROM qa_slack_inbox WHERE workspace_id=? AND expires_at<=?').bind(ws,now).run();
      if(!await qaSlackEnabled(env,ws))return [];
      const pending=await env.DB.prepare("SELECT id FROM qa_slack_inbox WHERE workspace_id=? AND state='pending' AND next_attempt_at<=? AND (lease_until IS NULL OR lease_until<=?) ORDER BY next_attempt_at LIMIT 20").bind(ws,now,now).all<{id:string}>();
      const result:Array<{id:string;payload:QaSlackPayload}>=[];
      for(const item of pending.results){const row=await claimInbox(env,ws,item.id);if(row)result.push(row);}
      return result;
    },
    slack,
    reply: async (p, message) => {
      const user = p.user_id || p.user?.id || p.event?.user, channel = p.channel_id || p.channel?.id || p.event?.channel;
      if (!user) return;
      if (channel) { try { await slack('chat.postEphemeral', {channel,user,text:message}); return; } catch { /* private fallback */ } }
      const dm = await slack('conversations.open', { users: user }); await slack('chat.postMessage', {channel:dm.channel.id,text:message});
    },
    background: work => ctx.waitUntil(work), link: issue => qaSlackLink(env, issue),
  };
  return adapter;
}
/** Existing scheduled delivery provides bounded retries; every data operation remains tenant scoped. */
export async function runQaSlackInbox(env:Env,ctx:Ctx):Promise<void>{
  const scopes=await env.DB.prepare("SELECT workspace_id FROM system_settings WHERE key='feature_toggles' UNION SELECT workspace_id FROM qa_slack_inbox UNION SELECT workspace_id FROM qa_upload_sessions WHERE state IN ('initializing','uploading','finalizing','aborting')").all<{workspace_id:string}>();
  for(const {workspace_id:ws} of scopes.results){
    try{
      await env.DB.prepare('DELETE FROM qa_slack_inbox WHERE workspace_id=? AND expires_at<=?').bind(ws,new Date().toISOString()).run();
      await cleanupQaExpiredUploads(env,ws);
      await drainQaSlackInbox(createCloudQaSlackActions(env,ws,ctx));
    }
    catch{console.error('qa_slack_inbox_retry_failed');}
  }
}
export async function handleQaSlackHttp(c: Context<AppContext>): Promise<Response> {
  const ws = c.req.param('workspaceId');
  if (!ws || !/^[\w-]{1,100}$/.test(ws)) return c.json({error:'invalid_workspace'},400);
  if (Number(c.req.header('content-length') || 0) > 100000) return c.json({error:'too_large'},413);
  const body = await c.req.text();
  if (body.length > 100000) return c.json({error:'too_large'},413);
  if (!await verifyQaSlackSignature(c.env.SLACK_SIGNING_SECRET,c.req.header('x-slack-request-timestamp') || null,c.req.header('x-slack-signature') || null,body)) return c.json({error:'invalid_signature'},401);
  try {
    const form = new URLSearchParams(body);
    const payload = c.req.header('content-type')?.includes('application/json') ? JSON.parse(body) : form.has('payload') ? JSON.parse(form.get('payload')!) : Object.fromEntries(form);
    if (payload.type === 'url_verification') return c.json({challenge:payload.challenge});
    if (isKnowledgeSlackPayload(payload)) return c.json(await handleKnowledgeSlack(payload, createCloudKnowledgeSlackActions(c.env,ws,c.executionCtx)) || {});
    if (!isQaSlackPayload(payload)) return c.json({response_type:'ephemeral',text:'LIVO：/livo kb 搜尋知識庫；/livo bug new 或 /livo bug show BUG_ID'});
    const actions = createCloudQaSlackActions(c.env,ws,c.executionCtx);
    return c.json(await handleQaSlack(payload as QaSlackPayload, payload.event_id || c.req.header('x-slack-request-timestamp') || '', actions));
  } catch { return c.json({error:'qa_slack_failed'},500); }
}
