import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), signedUpload: vi.fn(), createClient: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: { auth: { getSession: mocks.session }, storage: { from: () => ({ uploadToSignedUrl: mocks.signedUpload }) } } }));
vi.mock('@/lib/apiBase', () => ({ fnUrl: () => 'https://example.test/qa' }));
vi.mock('@/lib/gatewayUrl', () => ({ SUPABASE_URL: 'https://storage.example.test' }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { createQaClient, qaId } from '@/lib/qa/client';
import { parseQaNotification } from '@/lib/qa/notifications';
import { resolveFeatureToggles, resolveQaView } from '@/lib/featureToggles';
import type { QaContext } from '@/lib/qa/domain';
const input = { projectId: 'p1', title: 'An issue', actual: 'Unexpected result', observedEnvironment: 'Stage' };
const context = (): QaContext => ({ actor: { id: 'admin', role: 'admin' }, workspaceId: crypto.randomUUID(), now: '2026-10-02T00:00:00Z', newId: () => crypto.randomUUID(), memberIds: new Set(['admin', 'dev']), projectIds: new Set(['p1']), taskIds: new Set(['task1']) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-test-key'); mocks.session.mockResolvedValue({ data: { session: { access_token: 'test-token' } } }); mocks.signedUpload.mockResolvedValue({ error: null }); mocks.createClient.mockReturnValue({ storage: { from: () => ({ uploadToSignedUrl: mocks.signedUpload }) } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('QA client capability and isolated demo', () => {
  it('loads version suggestions through the QA endpoint with project and abort signal', async () => {
    const fetchMock = vi.fn(async () => Response.json(['build-a'])); vi.stubGlobal('fetch', fetchMock);
    const client = createQaClient({ enabled: () => true, context }), controller = new AbortController();
    expect(await client.versions('p1', controller.signal)).toEqual(['build-a']);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/qa', expect.objectContaining({ signal: controller.signal,
      body: JSON.stringify({ action: 'versions', projectId: 'p1' }) }));
  });
  it('scopes demo versions by project and keeps free-text versions unchanged', async () => {
    const ctx = context(); ctx.projectIds = new Set(['p1', 'p2']);
    const client = createQaClient({ enabled: () => true, context: () => ctx, mock: true });
    await client.create({ ...input, observedVersion: 'custom-build' });
    await client.create({ ...input, projectId: 'p2', observedVersion: 'other-project' });
    expect(await client.versions('p1')).toEqual(['custom-build']);
    expect(await client.versions('')).toEqual([]);
    await expect(client.versions('hidden')).rejects.toMatchObject({ status: 403 });
  });
  it('creates QA UUIDs on HTTP without crypto.randomUUID', () => {
    const getRandomValues = vi.fn((bytes: Uint8Array) => { bytes.fill(42); return bytes; });
    vi.stubGlobal('crypto', { getRandomValues });
    expect(qaId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(getRandomValues).toHaveBeenCalledOnce();
  });
  it.each([undefined, {}, { qa: 'true' }, { qa: 1 }, { qa: false }])('defaults QA off for %j', value => {
    expect(resolveFeatureToggles(value, { hasApprovalRules: true, hasApprovalRequests: true }).qa).toBe(false);
    expect(resolveQaView('qa', false)).toBe('board'); expect(resolveQaView('my-qa', false)).toBe('board'); expect(resolveQaView('qa', true)).toBe('qa');
  });
  it('does not obtain a session or fetch when disabled, including an old client reference', async () => {
    let enabled = true; const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    const client = createQaClient({ enabled: () => enabled, context }); enabled = false;
    await expect(client.list({})).rejects.toMatchObject({ status: 403 });
    await expect(client.versions('p1')).rejects.toMatchObject({ status: 403 });
    await expect(client.create(input)).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it('uses the shared reducer in demo, preserves idempotency and never touches a backend', async () => {
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock); const ctx = context();
    const client = createQaClient({ enabled: () => true, context: () => ctx, mock: true });
    const issue = await client.create(input, 'demo-bug', 'same-create');
    expect(await client.create(input, 'demo-bug', 'same-create')).toEqual(issue);
    const triaged = await client.command(issue, { type: 'triage', assigneeId: 'dev', qaOwnerId: 'admin', priority: 2, severity: 'high', dueDate: null }, 'same-triage');
    expect(triaged.state).toBe('triaged'); expect((await client.list({})).total).toBe(1);
    await expect(client.command(issue, { type: 'hold', reason: 'stale' })).rejects.toMatchObject({ status: 409 });
    expect(fetchMock).not.toHaveBeenCalled(); expect(mocks.session).not.toHaveBeenCalled();
  });
  it('uploads Docker files using a signed token and completes only after storage succeeds', async () => {
    const actions: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); actions.push(body.action);
      return new Response(JSON.stringify(body.action === 'upload_init' ? { id: 'up1', provider: 'supabase', bucket: 'qa-private', path: 'b/file', token: 'signed-token', partSize: 0 } : { id: 'a1' }), { headers: { 'Content-Type': 'application/json' } });
    }));
    const client = createQaClient({ enabled: () => true, context }); const file = new File(['video'], 'proof.mp4', { type: 'video/mp4' });
    await client.upload('bug1', file);
    expect(mocks.signedUpload).toHaveBeenCalledWith('b/file', 'signed-token', file, { contentType: 'video/mp4' });
    expect(actions).toEqual(['upload_init', 'upload_complete']);
    expect(mocks.createClient).toHaveBeenCalledWith('https://storage.example.test', 'public-test-key', expect.objectContaining({ auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } }));
  });
  it('retains status 409 and server code for a conflict without replacing it with a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { code: 'qa_version_conflict', message: 'Changed' } }), { status: 409 })));
    await expect(createQaClient({ enabled: () => true, context }).get('bug1')).rejects.toMatchObject({ status: 409, code: 'qa_version_conflict' });
  });
  it('stops multipart uploads before the next part or completion when QA is disabled', async () => {
    let enabled = true; const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('upload_part')) { calls.push('part'); enabled = false; return new Response(JSON.stringify({ etag: 'part-one' })); }
      calls.push('init'); return new Response(JSON.stringify({ id: 'upload1', provider: 'r2', partSize: 5 }));
    }));
    const client = createQaClient({ enabled: () => enabled, context });
    await expect(client.upload('bug1', new File(['elevenbytes'], 'proof.mp4', { type: 'video/mp4' }))).rejects.toMatchObject({ status: 403 });
    expect(calls).toEqual(['init', 'part']);
  });
  it('parses QA notifications and rejects malformed/URL-like IDs', () => {
    expect(parseQaNotification(JSON.stringify({ kind: 'qa', issueId: 'bug-1', title: 'Fix me', event: 'triage' }))?.title).toBe('Fix me');
    expect(parseQaNotification('{"secret":"raw JSON"}')).toBeNull();
    expect(parseQaNotification(JSON.stringify({ kind: 'qa', issueId: 'javascript:alert(1)', title: 'x' }))).toBeNull();
  });
});
