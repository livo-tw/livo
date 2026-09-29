// Worker environment bindings + request context types shared by all modules.

export interface Env {
  DB: D1Database;
  ATTACHMENTS: R2Bucket;
  REALTIME: DurableObjectNamespace;
  ALLOWED_ORIGINS: string;
  // secrets
  JWT_SECRET: string;
  SLACK_BOT_TOKEN?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;
  /** Where hosted sign-up FYI emails go (waitlist requests, with the one-click
   *  approve link). Requires RESEND_API_KEY to actually send. */
  SELLER_NOTIFY_EMAIL?: string;
  /** Public origin of the web app (used in email links), e.g. https://pm.example.com */
  APP_BASE_URL?: string;
  /** Public origin of this API, e.g. https://api.pm.example.com */
  API_BASE_URL?: string;
  /** "1" → enable the hosted sign-up flow (public waitlist → emailed invite →
   *  new workspace per team). Only for operators hosting LIVO for several
   *  teams; a normal self-hosted install leaves it unset. */
  CLOUD_SIGNUP?: string;
  /** "1" → this whole instance is a PUBLIC DEMO. Master switch that turns on
   *  all demo protections at once: destructive/admin actions blocked for EVERY
   *  member (all seeded accounts share a demo password, so guarding one email
   *  is not enough) and hourly wipe+reseed. Task browsing/creating/moving
   *  stays fully usable. */
  DEMO_MODE?: string;
  /** "1" → hourly wipe+reseed of the public demo instance in scheduled(). */
  DEMO_RESET?: string;
  /** "1" → block the (no-op) license RPCs for everyone on this instance. */
  DEMO_LOCK_LICENSE?: string;
  /** Shared demo super-admin email (e.g. jianhong@livo.test). When set, that
   *  member is blocked from destructive/admin actions (see demoGuard). */
  DEMO_ACCOUNT_EMAIL?: string;
}

/**
 * Minimal execution context. Both hono's `c.executionCtx` and the Workers
 * runtime `ExecutionContext` satisfy this structurally (workers-types v5
 * added a `tracing` field that hono's type lacks — depend on neither).
 */
export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export interface MemberCtx {
  id: string;
  role: string; // 'super_admin' | 'admin' | 'member'
  email: string;
  name: string;
  /** Tenancy scope — 'default' for self-host/local installs and the demo. */
  workspaceId: string;
}

export interface AuthCtx {
  userId: string; // auth_users.id (JWT sub)
  email: string;
  member: MemberCtx;
}

/** Hono generic: `new Hono<AppContext>()` */
export type AppContext = {
  Bindings: Env;
  Variables: { auth: AuthCtx };
};

export const appBaseUrl = (env: Env) => env.APP_BASE_URL || 'http://localhost:5173';
export const apiBaseUrl = (env: Env) => env.API_BASE_URL || 'http://localhost:8787';

/** Friendly zh-TW rejection shown when the shared demo account is blocked. */
export const DEMO_BLOCKED_MESSAGE = '展示帳號無法執行此操作';

/** Self-host/local installs and the public demo all live in workspace
 *  'default'; hosted sign-ups get a workspace of their own. */
export const DEFAULT_WORKSPACE = 'default';

/** True when hosted sign-up (waitlist → invite → new workspace) is enabled. */
export const isCloudSignupEnabled = (env: Env): boolean => env.CLOUD_SIGNUP === '1';

/** True when this whole instance is a public demo (master switch). */
export const isDemoInstance = (env: Env): boolean => env.DEMO_MODE === '1';

/** DEMO_MODE semantics: only workspace 'default' is the demo. Hosted
 *  workspaces on the same instance are REAL users with full rights. */
export const isDemoWorkspace = (env: Env, workspaceId: string | null | undefined): boolean =>
  isDemoInstance(env) && (workspaceId || DEFAULT_WORKSPACE) === DEFAULT_WORKSPACE;

/** Member-level demo check (replaces isDemoAccount at authed call sites):
 *  DEMO_MODE gates only default-workspace members; the standalone
 *  DEMO_ACCOUNT_EMAIL match keeps working when DEMO_MODE is off. */
export const isDemoMember = (env: Env, auth: AuthCtx | null | undefined): boolean => {
  if (!auth) return false;
  if (isDemoWorkspace(env, auth.member.workspaceId)) return true;
  const demo = (env.DEMO_ACCOUNT_EMAIL || '').trim().toLowerCase();
  return demo !== '' && (auth.member.email || '').trim().toLowerCase() === demo;
};

/** True when the license RPCs must be blocked instance-wide (demo lock or
 *  the DEMO_MODE master switch). */
export const isDemoLocked = (env: Env): boolean =>
  env.DEMO_LOCK_LICENSE === '1' || isDemoInstance(env);

/** True when the acting member must be treated as a demo user (blocked from
 *  destructive/admin actions). On a DEMO_MODE instance EVERY member counts
 *  (all seeded accounts share a demo password); otherwise only the specific
 *  DEMO_ACCOUNT_EMAIL matches. Empty/unset → false, so real installs are safe. */
export const isDemoAccount = (env: Env, email: string | null | undefined): boolean => {
  if (isDemoInstance(env)) return true;
  const demo = (env.DEMO_ACCOUNT_EMAIL || '').trim().toLowerCase();
  return demo !== '' && (email || '').trim().toLowerCase() === demo;
};
