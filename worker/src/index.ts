import { handleKnowledgeWork } from './knowledgeWork';
import { handleTaskWorkCommand } from './taskWork';
// LIVO API Worker — entrypoint & routing. Module contracts:
//   auth.ts      → registerAuthRoutes(app), requireMember (middleware),
//                  verifyAccessToken(env, token): Promise<{sub, email} | null>
//   db.ts        → runQuery(env, ctx, auth, QueryRequest): Promise<QueryResponse>
//   rpc.ts       → handleRpc(c, fn): Promise<Response>  (license stubs + field locks)
//   realtime.ts  → class RealtimeHub (Durable Object; /ws upgrade, /notify POST)
//   storage.ts   → handleUpload / handleDownload / handleRemove
//   functions/*  → one handler per legacy Edge Function

import { Hono } from 'hono';
import type { Handler, MiddlewareHandler } from 'hono';
import { cors } from 'hono/cors';
import type { AppContext, Env } from './env';
import { DEFAULT_WORKSPACE, DEMO_BLOCKED_MESSAGE, isCloudSignupEnabled, isDemoMember } from './env';
import type { QueryRequest } from './protocol';
import {
  pruneLoginAttempts,
  registerAuthRoutes,
  requireMember,
  resolveActiveMember,
  verifyAccessToken,
} from './auth';
import { hubName } from './notify';
import { handleCloudWaitlist, handleCloudWaitlistApprove } from './functions/cloudBeta';
import { runQuery, roleRank } from './db';
import { handleRpc } from './rpc';
import { handleUpload, handleDownload, handleRemove, isKnowledgeStoragePath } from './storage';
import { handleQa } from './qa';
import { handleReleaseWorkspace } from './releases';
import { handleApprovalCommand } from './approval';
import { runApprovalDeliveries } from './approvalDelivery';
import { handleKnowledgeWorkflow } from './knowledgeWorkflow';
import { handleKnowledgeImport } from './functions/knowledgeImport';
import { runKnowledgeImportCleanup } from './functions/knowledgeImportCleanup';
import { ImportError } from './knowledgeImport';
import { handleQaSlackHttp, runQaSlackInbox } from './qaSlack';
import { handleManageMember } from './functions/manageMember';
import {
  handleSlackNotify,
  handleSlackChannels,
  runSlackDigest,
  handleSlackConfigStatus,
  handleSlackConfigSet,
} from './functions/slack';
import {
  handleEmailConfigStatus,
  handleEmailConfigSet,
  runDueReminders,
} from './functions/emailNotify';
import { handleWebhooksGet, handleWebhooksPost } from './functions/webhooks';
import { handleApiTokensGet, handleApiTokensPost } from './functions/apiTokens';
import { handleBackup, runScheduledBackup } from './functions/backup';
import { handleImportJira } from './functions/importJira';
import { runDemoReset } from './demoReset';
import { handleOgTask } from './functions/ogTask';

export { RealtimeHub } from './realtime';

const app = new Hono<AppContext>();

// ── CORS ──────────────────────────────────────────────────────────────────
const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/;

app.use('*', (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return cors({
    // Bearer-token API (no cookies) — allowing localhost origins for dev tools
    // carries no CSRF risk; production origins come from ALLOWED_ORIGINS.
    origin: (origin) => (allowed.includes(origin) || LOCALHOST_RE.test(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type', 'Range', 'x-file-name', 'apikey', 'x-client-info'],
    exposeHeaders: ['Content-Range', 'Accept-Ranges', 'Content-Length'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    maxAge: 86400,
  })(c, next);
});

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }));

// ── Demo write-guard (contract T3) ─────────────────────────────────────────
// Runs AFTER requireMember. On a public demo instance (DEMO_MODE=1) members
// may browse/move tasks, but are blocked from destructive admin actions:
// manage-member, the real import-jira, and manual backup. (system_settings
// writes are blocked in db.ts.)
const demoGuard: MiddlewareHandler<AppContext> = async (c, next) => {
  const auth = c.get('auth');
  // Workspace-scoped: only default-workspace members are demo users on a
  // DEMO_MODE instance — hosted workspaces keep full rights.
  if (auth && isDemoMember(c.env, auth)) {
    return c.json({ error: DEMO_BLOCKED_MESSAGE }, 403);
  }
  await next();
};

// ── Hosted sign-up gate ────────────────────────────────────────────────────
// The waitlist → invite → sign-up flow creates new workspaces on this
// instance. It is for operators who host LIVO for several teams and is off
// unless CLOUD_SIGNUP=1 (see CLOUD_SIGNUP in env.ts).
const cloudSignupOnly: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!isCloudSignupEnabled(c.env)) {
    return c.json({ error: { message: `No route: ${c.req.method} ${c.req.path}` } }, 404);
  }
  await next();
};

// ── Role guards (run AFTER requireMember) ──────────────────────────────────
// Route-level companions of the /api/query permission floor in db.ts:
// destructive/config endpoints need admin or super_admin.
const requireRank = (minRank: number): MiddlewareHandler<AppContext> => async (c, next) => {
  const auth = c.get('auth');
  if (!auth || roleRank(auth.member.role) < minRank) {
    return c.json({ error: '權限不足' }, 403);
  }
  await next();
};
const requireAdmin = requireRank(1); // admin or super_admin
const requireSuperAdmin = requireRank(2); // super_admin only

// ── Auth ──────────────────────────────────────────────────────────────────
registerAuthRoutes(app);

// ── Query engine ──────────────────────────────────────────────────────────
app.post('/api/query', requireMember, async (c) => {
  const req = (await c.req.json()) as QueryRequest;
  const res = await runQuery(c.env, c.executionCtx, c.get('auth'), req);
  return c.json(res);
});

// ── RPC (license stubs are public; lock fns check member inside) ──────────
app.post('/api/rpc/:fn', (c) => handleRpc(c, c.req.param('fn')));
app.post('/rest/v1/rpc/:fn', (c) => handleRpc(c, c.req.param('fn'))); // legacy keepalive beacons

// ── Functions (Edge Function ports) ───────────────────────────────────────
app.post('/api/functions/qa', requireMember, handleQa); // read/write demo and opt-in guards are action-aware
app.post('/api/functions/task-work-command', requireMember, handleTaskWorkCommand);
app.post('/api/functions/approval-command', requireMember, handleApprovalCommand);
app.post('/api/functions/knowledge-work', requireMember, handleKnowledgeWork);
app.post('/api/functions/release-workspace', requireMember, handleReleaseWorkspace);
app.post('/api/functions/knowledge-workflow', requireMember, handleKnowledgeWorkflow);
const knowledgeImport: Handler<AppContext> = async (c) => {
  try {
    const raw = await c.req.text();
    if (raw.length > 30 * 1024 * 1024) return c.json({ error: { code: 'file_too_large', message: 'file_too_large' } }, 413);
    return c.json(await handleKnowledgeImport(c.env, c.executionCtx, c.get('auth'), JSON.parse(raw)));
  } catch (error) {
    const status = error instanceof ImportError ? error.status : error instanceof SyntaxError ? 400 : 500;
    const code = error instanceof ImportError ? error.code : error instanceof SyntaxError ? 'invalid_request' : 'import_failed';
    return c.json({ error: { code, message: code } }, status as 400);
  }
};
app.post('/api/functions/knowledge-import', requireMember, knowledgeImport);
app.post('/api/functions/qa-slack/:workspaceId', handleQaSlackHttp); // Slack HMAC + timestamp; actor/workspace checked by adapter
app.post('/api/functions/slack-interact/:workspaceId', handleQaSlackHttp);
app.post('/api/functions/manage-member', requireMember, demoGuard, handleManageMember);
app.post('/api/functions/slack-notify', requireMember, handleSlackNotify);
app.post('/api/functions/slack-channels', requireMember, handleSlackChannels);
// Customer self-bind: read masked status (any member) / set token (admin; demo-blocked)
app.get('/api/functions/slack-config', requireMember, handleSlackConfigStatus);
app.post('/api/functions/slack-config', requireMember, demoGuard, requireAdmin, handleSlackConfigSet);
// Email notify self-bind (slack-config twin): read masked status (any member)
// / set key (admin; demo-blocked). GET stays open so the demo UI renders.
app.get('/api/functions/email-config', requireMember, handleEmailConfigStatus);
app.post('/api/functions/email-config', requireMember, demoGuard, requireAdmin, handleEmailConfigSet);
// Outbound webhooks admin CRUD. GET (secret-free list) stays demo-readable;
// all writes are admin + demo-blocked.
app.get('/api/functions/webhooks', requireMember, requireAdmin, handleWebhooksGet);
app.post('/api/functions/webhooks', requireMember, demoGuard, requireAdmin, handleWebhooksPost);
// API tokens (PAT): plain token returned once on create; writes demo-blocked.
app.get('/api/functions/api-tokens', requireMember, requireAdmin, handleApiTokensGet);
app.post('/api/functions/api-tokens', requireMember, demoGuard, requireAdmin, handleApiTokensPost);
app.post('/api/functions/import-jira', requireMember, demoGuard, requireAdmin, handleImportJira);
// Manual backup trigger is super-admin-only UI (SystemAdminView).
app.post('/api/functions/scheduled-backup', requireMember, demoGuard, requireSuperAdmin, handleBackup);
// Hosted sign-up: public waitlist form + operator one-click approve link
app.post('/api/functions/cloud-waitlist', cloudSignupOnly, handleCloudWaitlist);
app.get('/api/functions/cloud-waitlist-approve', cloudSignupOnly, handleCloudWaitlistApprove);
app.get('/api/functions/og-task', handleOgTask);

// Legacy /functions/v1/* aliases (old hardcoded URLs)
app.post('/functions/v1/knowledge-workflow', requireMember, handleKnowledgeWorkflow);
app.post('/functions/v1/knowledge-import', requireMember, knowledgeImport);
app.post('/functions/v1/manage-member', requireMember, demoGuard, handleManageMember);
app.post('/functions/v1/slack-notify', requireMember, handleSlackNotify);
app.post('/functions/v1/task-work-command', requireMember, handleTaskWorkCommand);
app.post('/functions/v1/approval-command', requireMember, handleApprovalCommand);
app.post('/functions/v1/knowledge-work', requireMember, handleKnowledgeWork);
app.post('/functions/v1/release-workspace', requireMember, handleReleaseWorkspace);
app.post('/functions/v1/import-jira', requireMember, demoGuard, requireAdmin, handleImportJira);
app.post('/functions/v1/scheduled-backup', requireMember, demoGuard, requireSuperAdmin, handleBackup);
app.get('/functions/v1/og-task', handleOgTask);

// ── Storage ───────────────────────────────────────────────────────────────
app.get('/api/storage/task-images/*', async (c, next) => {
  const path = decodeURIComponent(c.req.path.replace(/^\/api\/storage\/task-images\//, ''));
  if (isKnowledgeStoragePath(path)) return requireMember(c, next);
  return next();
}, (c) =>
  handleDownload(c, 'task-images', c.req.path.replace(/^\/api\/storage\/task-images\//, ''))
);
app.get('/api/storage/kb-files/*', requireMember, (c) =>
  handleDownload(c, 'kb-files', decodeURIComponent(c.req.path.replace(/^\/api\/storage\/kb-files\//, '')))
);
// Backups hold full-workspace dumps → super-admin only, and storage.ts
// additionally enforces the per-workspace key prefix.
// Demo-guarded too: the public demo's super-admin login is published on the
// website, and backup names are timestamps, so without the guard anyone could
// sign in and fetch default-namespace dumps by guessing dates.
app.get('/api/storage/backups/*', requireMember, demoGuard, requireSuperAdmin, (c) =>
  handleDownload(c, 'backups', c.req.path.replace(/^\/api\/storage\/backups\//, ''))
);
// Storage writes are demo-guarded too: the hourly reset doesn't touch R2, so
// demo users deleting backups/images or flooding uploads would be permanent.
app.post('/api/storage/:bucket/remove', requireMember, demoGuard, (c) => {
  const bucket = c.req.param('bucket');
  // Backup deletion is super-admin-only (SystemAdminView); task-images
  // removal stays member-open (own uploads, healed by task realtime).
  if (bucket === 'backups' && roleRank(c.get('auth').member.role) < 2) {
    return c.json({ error: '權限不足' }, 403);
  }
  return handleRemove(c, bucket);
});
app.post('/api/storage/:bucket/*', requireMember, demoGuard, (c) => {
  const bucket = c.req.param('bucket');
  const path = c.req.path.replace(new RegExp(`^/api/storage/${bucket}/`), '');
  return handleUpload(c, bucket, decodeURIComponent(path));
});

// ── Realtime (WebSocket → Durable Object) ─────────────────────────────────
app.get('/api/realtime', async (c) => {
  if (c.req.header('Upgrade')?.toLowerCase() !== 'websocket') {
    return c.text('Expected WebSocket upgrade', 426);
  }
  const token = c.req.query('token') || '';
  const claims = await verifyAccessToken(c.env, token);
  if (!claims) return c.text('Unauthorized', 401);

  // Tenancy isolation: each workspace gets its OWN hub instance, so client-
  // declared channel bindings can only ever see same-workspace events.
  const resolved = await resolveActiveMember(c.env, claims.sub, claims.email);
  if (!resolved.ok) return c.text('Unauthorized', 401);
  const ws = resolved.member.workspace_id || DEFAULT_WORKSPACE;

  const headers = new Headers(c.req.raw.headers);
  headers.set('x-auth-user', claims.sub);
  headers.set('x-auth-email', claims.email);
  const stub = c.env.REALTIME.get(c.env.REALTIME.idFromName(hubName(ws)));
  return stub.fetch(new Request('https://do/ws', { method: 'GET', headers }));
});

app.notFound((c) => c.json({ error: { message: `No route: ${c.req.method} ${c.req.path}` } }, 404));

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.allSettled([
        runKnowledgeImportCleanup(env), // system retention: all tenants, including disabled importers
        runScheduledBackup(env, ctx),
        runQaSlackInbox(env, ctx),
        runApprovalDeliveries(env),
        runSlackDigest(env, ctx),
        runDueReminders(env), // due-soon notifications+emails, daily 09:00 台灣 self-gate
        runDemoReset(env), // hourly demo wipe+reseed when DEMO_RESET==="1" (T2b)
        pruneLoginAttempts(env), // login-throttle rows whose window and lock have lapsed
      ]).then(() => {})
    );
  },
} satisfies ExportedHandler<Env>;
