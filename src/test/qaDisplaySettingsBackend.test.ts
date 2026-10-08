// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createQaService } from '../../docker/volumes/functions/qa/service';
import type { QaDisplaySettings } from '../lib/qa/displaySettings';
import { lintUpgradeMigration } from '../../scripts/release-upgrades.mjs';

const AUTH = '00000000-0000-0000-0000-000000000001';
const configuration: QaDisplaySettings = { version: 1, showSeverity: false, hiddenPriorityChoices: [1, 5], hiddenBoardStates: ['triaged', 'closed'] };
const defaults: QaDisplaySettings = { version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] };
const settings: Record<string, string> = { SUPABASE_URL: 'https://backend.example.com', SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_SERVICE_ROLE_KEY: 'fixture-service' };
const env = { get: (key: string) => settings[key] };
let role: string, active: boolean, qaAdmin: boolean, stored: unknown, rpcFailure: unknown;
let calls: Array<{ path: string; query: URLSearchParams; body: Record<string, unknown> | undefined }>;
beforeEach(() => {
  role = 'super_admin'; active = true; qaAdmin = false; stored = undefined; rpcFailure = undefined; calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const parsed = new URL(url), body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: parsed.pathname, query: parsed.searchParams, body });
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (parsed.pathname === '/auth/v1/user') return json({ id: AUTH });
    if (parsed.pathname === '/rest/v1/members') return json(active ? [{ id: 'example-member', auth_id: AUTH, role, is_active: true, is_qa_admin: qaAdmin }] : []);
    if (parsed.pathname === '/rest/v1/system_settings') {
      const key = parsed.searchParams.get('key');
      if (key === 'eq.feature_toggles') return json([{ value: { qa: true } }]);
      if (key === 'eq.qa_display_settings') return json(stored === undefined ? [] : [{ value: stored }]);
    }
    if (parsed.pathname === '/rest/v1/rpc/livo_qa_save_display_settings') {
      if (rpcFailure) return json(rpcFailure, 403);
      stored = body.p_configuration; return json(stored);
    }
    throw new Error('Unexpected fixture request: ' + parsed.pathname);
  }));
});
afterEach(() => vi.unstubAllGlobals());
const api = () => createQaService(env, 'fixture-session');

describe('Docker QA display settings retain the super administrator boundary', () => {
  it.each(['member', 'admin'])('denies %s before any write RPC', async value => {
    role = value;
    await expect(api().handle({ action: 'save_display_settings', configuration })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(calls.some(call => call.path.startsWith('/rest/v1/rpc/'))).toBe(false);
  });
  it('QA administrator capability does not grant workspace presentation administration', async () => {
    role = 'member'; qaAdmin = true;
    await expect(api().handle({ action: 'save_display_settings', configuration })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(stored).toBeUndefined();
  });
  it('inactive super administrators cannot read or save', async () => {
    active = false;
    for (const request of [{ action: 'get_display_settings' }, { action: 'save_display_settings', configuration }]) {
      await expect(api().handle(request)).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    }
    expect(stored).toBeUndefined();
  });
  it.each(['member', 'admin', 'super_admin'])('active %s reads defaults and current display settings', async value => {
    role = value;
    expect(await api().handle({ action: 'get_display_settings' })).toEqual(defaults);
    stored = configuration;
    expect(await api().handle({ action: 'get_display_settings' })).toEqual(configuration);
    const reads = calls.filter(call => call.query.get('key') === 'eq.qa_display_settings');
    expect(reads.every(call => call.query.get('select') === 'value' && call.query.get('limit') === '1')).toBe(true);
  });
  it('forwards only the authenticated login and validated configuration to the service RPC', async () => {
    expect(await api().handle({ action: 'save_display_settings', configuration, authId: 'forged-login', actorId: 'other-member', workspaceId: 'other-tenant' })).toEqual(configuration);
    expect(calls.find(call => call.path === '/rest/v1/rpc/livo_qa_save_display_settings')?.body).toEqual({ p_auth_id: AUTH, p_configuration: configuration });
    expect(await api().handle({ action: 'get_display_settings' })).toEqual(configuration);
  });
  it.each([{ ...configuration, hiddenPriorityChoices: [1, 1] }, { ...configuration, showSeverity: 'false' }, { ...configuration, hiddenBoardStates: ['unknown'] }, { ...configuration, extra: true }])('rejects invalid configuration before RPC: %j', async value => {
    await expect(api().handle({ action: 'save_display_settings', configuration: value })).rejects.toMatchObject({ code: 'qa_invalid_display_settings' });
    expect(stored).toBeUndefined();
    expect(calls.some(call => call.path.startsWith('/rest/v1/rpc/'))).toBe(false);
  });
  it('propagates the transaction fresh actor rejection', async () => {
    rpcFailure = { code: '42501', message: 'qa_forbidden' };
    await expect(api().handle({ action: 'save_display_settings', configuration })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
    expect(stored).toBeUndefined();
  });
  it('propagates the transaction configuration validation error', async () => {
    rpcFailure = { code: '22023', message: 'qa_invalid_display_settings' };
    await expect(api().handle({ action: 'save_display_settings', configuration })).rejects.toMatchObject({ code: 'qa_invalid_display_settings', status: 400 });
  });
  it('adds a repeatable upgrade without modifying published migrations', () => {
    const migration = fs.readFileSync(path.resolve('supabase/migrations/20261101_qa_display_settings.sql'), 'utf8');
    expect(lintUpgradeMigration(migration)).toEqual([]);
    expect(migration).toContain("role::text='super_admin' FOR SHARE");
    expect(migration).toContain('FROM PUBLIC,anon,authenticated');
    expect(migration).toContain("'qa_display_settings_identity_immutable'");
  });
});
