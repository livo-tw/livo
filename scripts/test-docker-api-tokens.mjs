#!/usr/bin/env node
// ============================================================
// LIVO 自架版（Docker）個人 API 金鑰 — 端對端測試
// ============================================================
// 對一套「正在執行」的 Docker 安裝實際打 API，驗證：
//   建立 / 列出 / 撤銷金鑰、換證成功、換來的權杖能用 PostgREST 與其他
//   functions、不能改密碼、撤銷後與成員停用後不能換證、一般成員不能建立金鑰、
//   管理員不能把金鑰綁到其他管理員。
//
// 用法（在任何地方執行；需要 Node 18+）：
//   node scripts/test-docker-api-tokens.mjs --dir <安裝目錄>
// <安裝目錄> 是有 docker/.env 的那一層（例如 release/livo-release）。
// 會建立 3 個假帳號（pat-e2e-*@example.com）與一個測試專案，結束時全部刪除。
// 會用到 docker/.env 的 SERVICE_ROLE_KEY，只在本機測試環境執行。
// ============================================================

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const argDir = process.argv.indexOf('--dir');
const ROOT = argDir > 0 ? path.resolve(process.argv[argDir + 1]) : process.cwd();
const envFile = path.join(ROOT, 'docker', '.env');
if (!fs.existsSync(envFile)) {
  console.error(`找不到 ${envFile}（--dir 要指到安裝目錄）`);
  process.exit(2);
}
const env = Object.fromEntries(
  fs.readFileSync(envFile, 'utf8').split(/\r?\n/)
    .map((l) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);
const API = `http://localhost:${env.KONG_HTTP_PORT || '8000'}`;
const ANON = env.ANON_KEY;
const SERVICE = env.SERVICE_ROLE_KEY;

const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = `E2e-${crypto.randomBytes(9).toString('base64url')}`;
const people = {
  admin: { email: `pat-e2e-admin-${RUN}@example.com`, role: 'admin', name: '測試管理員' },
  member: { email: `pat-e2e-member-${RUN}@example.com`, role: 'member', name: '測試成員' },
  ai: { email: `pat-e2e-ai-${RUN}@example.com`, role: 'admin', name: 'AI 專用帳號' },
  boss: { email: `pat-e2e-super-${RUN}@example.com`, role: 'super_admin', name: '測試超級管理員' },
};

let failures = 0;
function check(label, cond, detail) {
  if (cond) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`);
  }
}

async function call(method, url, { token, apikey = ANON, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (apikey) headers.apikey = apikey;
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
}
const asService = (method, url, body) =>
  call(method, url, { token: SERVICE, apikey: SERVICE, body });
const fn = (method, name, token, body) => call(method, `/functions/v1/${name}`, { token, apikey: null, body });

async function login(email, password = PASSWORD) {
  const r = await call('POST', '/auth/v1/token?grant_type=password', { body: { email, password } });
  return r.status === 200 ? r.body.access_token : null;
}

const created = { users: [], members: [], project: null };

async function setup() {
  for (const [key, p] of Object.entries(people)) {
    const u = await asService('POST', '/auth/v1/admin/users', {
      email: p.email, password: PASSWORD, email_confirm: true,
    });
    if (u.status !== 200) throw new Error(`建立登入帳號失敗：${JSON.stringify(u.body)}`);
    created.users.push(u.body.id);
    const id = `m-e2e-${key}-${RUN}`;
    const m = await call('POST', '/rest/v1/members', {
      token: SERVICE, apikey: SERVICE,
      body: { id, name: p.name, avatar: p.name.slice(0, 1), role: p.role, email: p.email, auth_id: u.body.id, is_active: true },
    });
    if (m.status !== 201) throw new Error(`建立成員失敗：${JSON.stringify(m.body)}`);
    created.members.push(id);
    p.id = id;
    p.authId = u.body.id;
  }
  const line = `pl-e2e-${RUN}`;
  const project = `p-e2e-${RUN}`;
  await asService('POST', '/rest/v1/product_lines', { id: line, name: 'E2E 產品線' });
  const pr = await asService('POST', '/rest/v1/projects', { id: project, line_id: line, name: 'E2E 專案', key: `E${RUN.slice(0, 3).toUpperCase()}` });
  if (pr.status !== 201) throw new Error(`建立測試專案失敗：${JSON.stringify(pr.body)}`);
  created.project = { line, project };
}

async function cleanup() {
  if (created.project) {
    await asService('DELETE', `/rest/v1/tasks?project_id=eq.${created.project.project}`);
    await asService('DELETE', `/rest/v1/projects?id=eq.${created.project.project}`);
    await asService('DELETE', `/rest/v1/product_lines?id=eq.${created.project.line}`);
  }
  for (const id of created.members) await asService('DELETE', `/rest/v1/members?id=eq.${id}`); // api_tokens cascade
  for (const id of created.users) await asService('DELETE', `/auth/v1/admin/users/${id}`);
}

async function main() {
  console.log(`LIVO API 金鑰端對端測試 → ${API}`);
  await setup();
  const adminJwt = await login(people.admin.email);
  const memberJwt = await login(people.member.email);
  const bossJwt = await login(people.boss.email);
  check('測試帳號可以登入', adminJwt && memberJwt && bossJwt);

  console.log('\n[權限]');
  let r = await fn('POST', 'api-tokens', memberJwt, { action: 'create', name: 'x' });
  check('一般成員不能建立金鑰（403）', r.status === 403, r);
  r = await fn('GET', 'api-tokens', memberJwt);
  check('一般成員不能列出金鑰（403）', r.status === 403, r);
  r = await fn('POST', 'api-tokens', adminJwt, { action: 'create', name: 'x', memberId: people.boss.id });
  check('管理員不能把金鑰綁到超級管理員（403）', r.status === 403 && r.body.error === 'forbidden_member', r);

  console.log('\n[建立 / 列出]');
  r = await fn('POST', 'api-tokens', bossJwt, { action: 'create', name: 'E2E AI 助理', memberId: people.ai.id });
  check('超級管理員建立綁定 AI 帳號的金鑰', r.status === 200 && /^livo_pat_[0-9a-f]{32}$/.test(r.body.token || ''), r);
  const aiKey = r.body.token;
  const aiKeyId = r.body.id;
  r = await fn('GET', 'api-tokens', adminJwt);
  const listed = Array.isArray(r.body.tokens) ? r.body.tokens.find((t) => t.id === aiKeyId) : null;
  check('管理員列出金鑰（camelCase、綁定成員正確）', r.status === 200 && listed?.memberId === people.ai.id && listed.revokedAt === null, r);
  check('清單裡沒有金鑰本身或雜湊', !JSON.stringify(r.body).includes(aiKey) && !JSON.stringify(r.body).includes('token_hash'));
  r = await call('GET', '/rest/v1/api_tokens?select=*', { token: adminJwt });
  check('api_tokens 不能從 PostgREST 直接讀（管理員也不行）', r.status !== 200 || (Array.isArray(r.body) && r.body.length === 0), r);
  r = await call('GET', '/rest/v1/api_tokens?select=*', {});
  check('api_tokens 不能用 anon 讀', r.status !== 200 || (Array.isArray(r.body) && r.body.length === 0), r);

  console.log('\n[換證]');
  r = await fn('GET', 'api-tokens', aiKey);
  check('金鑰不能直接呼叫管理端點（401 use_exchange）', r.status === 401 && r.body.error === 'use_exchange', r);
  r = await fn('POST', 'api-tokens/exchange', aiKey);
  check('換證成功（200，15 分鐘）', r.status === 200 && r.body.token_type === 'bearer' && r.body.expires_in === 900, r);
  const jwt = r.body.access_token;
  check('換證回傳綁定成員', r.body.member?.id === people.ai.id, r.body.member);

  r = await call('GET', `/rest/v1/tasks?select=id,title&project_id=eq.${created.project.project}`, { token: jwt });
  check('換來的權杖可以讀任務（PostgREST）', r.status === 200 && Array.isArray(r.body), r);
  r = await call('POST', '/rest/v1/tasks', {
    token: jwt,
    body: { id: `t-e2e-${RUN}`, task_key: `E2E-${RUN}`, project_id: created.project.project, title: 'AI 建立的任務', status_id: 's1', creator_id: people.ai.id },
  });
  check('換來的權杖可以新增任務（PostgREST，走 RLS）', r.status === 201, r);
  r = await call('GET', `/rest/v1/members?select=id&auth_id=eq.${people.ai.authId}`, { token: jwt });
  check('RLS 把權杖認成綁定的成員', r.status === 200 && r.body[0]?.id === people.ai.id, r);
  r = await fn('GET', 'webhooks', jwt);
  check('換來的權杖可以呼叫其他 functions（webhooks，管理員）', r.status === 200, r);
  r = await call('GET', '/auth/v1/user', { token: jwt });
  check('換來的權杖可以讀自己的帳號（GET /auth/v1/user）', r.status === 200 && r.body.id === people.ai.authId, r);
  r = await call('PUT', '/auth/v1/user', { token: jwt, body: { password: 'Changed-by-key-1' } });
  check('換來的權杖不能改密碼（403）', r.status === 403 && r.body.code === 'livo_pat_readonly', r);
  r = await call('PUT', '/auth/v1/user', { token: jwt, body: { email: `changed-${RUN}@example.com` } });
  check('換來的權杖不能改 Email（403）', r.status === 403, r);
  r = await call('POST', '/auth/v1/logout?scope=global', { token: jwt });
  check('換來的權杖不能登出所有裝置（403）', r.status === 403, r);
  check('原密碼仍可登入', !!(await login(people.ai.email)));

  console.log('\n[撤銷]');
  r = await fn('POST', 'api-tokens', adminJwt, { action: 'revoke', id: aiKeyId });
  check('撤銷金鑰', r.status === 200 && r.body.ok === true, r);
  r = await fn('POST', 'api-tokens/exchange', aiKey);
  check('撤銷後不能換證（401）', r.status === 401, r);
  r = await fn('GET', 'api-tokens', adminJwt);
  check('清單顯示已撤銷', r.body.tokens?.find((t) => t.id === aiKeyId)?.revokedAt, r);

  console.log('\n[成員停用]');
  r = await fn('POST', 'api-tokens', adminJwt, { action: 'create', name: 'E2E 成員腳本', memberId: people.member.id });
  check('管理員可以把金鑰綁到一般成員', r.status === 200, r);
  const memberKey = r.body.token;
  r = await fn('POST', 'api-tokens/exchange', memberKey);
  check('停用前可以換證', r.status === 200, r);
  await call('PATCH', `/rest/v1/members?id=eq.${people.member.id}`, { token: SERVICE, apikey: SERVICE, body: { is_active: false } });
  r = await fn('POST', 'api-tokens/exchange', memberKey);
  check('成員停用後不能換證（403）', r.status === 403 && r.body.error === 'member_inactive', r);
}

try {
  await main();
} catch (e) {
  failures++;
  console.error(`\n✗ 測試中斷：${e.message}`);
} finally {
  await cleanup().catch((e) => console.error(`清理失敗：${e.message}`));
}
console.log(failures ? `\n❌ ${failures} 項失敗` : '\n✅ 全部通過');
process.exit(failures ? 1 : 0);
