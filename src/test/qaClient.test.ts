import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ session: vi.fn(), signedUpload: vi.fn(), createClient: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: false, supabase: { auth: { getSession: mocks.session }, storage: { from: () => ({ uploadToSignedUrl: mocks.signedUpload }) } } }));
vi.mock('@/lib/apiBase', () => ({ fnUrl: () => 'https://example.test/qa' }));
vi.mock('@/lib/gatewayUrl', () => ({ SUPABASE_URL: 'https://storage.example.test' }));
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }));
import { createQaClient, qaId, qaValidateUploadFile, type QaUploadResume } from '@/lib/qa/client';
import { parseQaNotification } from '@/lib/qa/notifications';
import { resolveFeatureToggles, resolveQaView } from '@/lib/featureToggles';
import type { QaContext, QaListInput } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW, getQaWorkflowColumns } from '@/lib/qa/workflow';
const input = { projectId: 'p1', title: 'An issue', actual: 'Unexpected result', observedEnvironment: 'Stage' };
const context = (): QaContext => ({ actor: { id: 'admin', role: 'admin' }, workspaceId: crypto.randomUUID(), now: '2026-10-02T00:00:00Z', newId: () => crypto.randomUUID(), memberIds: new Set(['admin', 'dev']), projectIds: new Set(['p1']), taskIds: new Set(['task1']) });
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('VITE_SUPABASE_PUBLISHABLE_KEY', 'public-test-key'); mocks.session.mockResolvedValue({ data: { session: { access_token: 'test-token' } } }); mocks.signedUpload.mockResolvedValue({ error: null }); mocks.createClient.mockReturnValue({ storage: { from: () => ({ uploadToSignedUrl: mocks.signedUpload }) } }); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('QA client capability and isolated demo', () => {
  it('keeps demo QA schema workspace-scoped and applies live capability and required-field rules',async()=>{
    const ctx=context();ctx.actor={id:'admin',role:'member',qaAdmin:true};
    const client=createQaClient({enabled:()=>true,context:()=>ctx,mock:true});
    const configuration={version:1 as const,fields:[{id:'reason',fieldName:'Reason',fieldType:'text' as const,isEnabled:true,isRequired:true,sortOrder:0}]};
    expect(await client.getFieldConfiguration()).toEqual({version:1,fields:[]});
    await client.saveFieldConfiguration(configuration);
    expect(await client.getFieldConfiguration()).toEqual(configuration);
    expect(await createQaClient({enabled:()=>true,context,mock:true}).getFieldConfiguration()).toEqual({version:1,fields:[]});
    await expect(client.create(input)).rejects.toMatchObject({code:'qa_custom_field_required'});
    const issue=await client.create({...input,customFields:{reason:'Repro'}});
    expect(issue.customFields).toEqual({reason:'Repro'});
    ctx.actor.qaAdmin=false;
    await expect(client.saveFieldConfiguration(configuration)).rejects.toMatchObject({code:'qa_forbidden'});
  });
  it('keeps demo manual-state audit and command replay aligned with the server contract', async () => {
    const ctx = context(), client = createQaClient({ enabled: () => true, context: () => ctx, mock: true });
    const issue = await client.create(input), command = { type: 'set_state' as const, state: 'failed' as const };
    const first = await client.command(issue, command, 'manual-state-command');
    expect(await client.command(issue, command, 'manual-state-command')).toEqual(first);
    const detail = await client.get(issue.id);
    expect(detail.issue).toMatchObject({ state: 'failed', runs: [], targets: [], fixCycle: 0 });
    const events = detail.events.filter(event => event.type === 'set_state');
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0].detail)).toMatchObject({ mode: 'manual', from: 'new', to: 'failed' });
  });
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
  it('intersects demo grouped states with project, search and ownership before counting and paginating', async () => {
    const ctx: QaContext = { ...context(), projectIds: new Set(['p1', 'p2']) };
    const client = createQaClient({ enabled: () => true, context: () => ctx, mock: true });
    const add = async (suffix: string, title: string, projectId = 'p1', owner: string | null = 'admin') => {
      let issue = await client.create({ ...input, title, projectId, qaOwnerId: null }, `${ctx.workspaceId}-${suffix}`);
      if (owner) issue = await client.command(issue, { type: 'triage', assigneeId: 'dev', qaOwnerId: owner, priority: 3, severity: 'high', dueDate: null });
      return issue;
    };
    const first = await add('a', 'Match first'), untriaged = await add('b', 'Match new', 'p1', null), last = await add('c', 'Match last');
    const closed = await add('d', 'Match closed'); await client.command(closed, { type: 'close', resolution: 'wont_fix', reason: 'Example decision' });
    await add('e', 'Match other project', 'p2'); await add('f', 'Other title'); await add('g', 'Match other owner', 'p1', 'dev');
    const otherWorkspace = context();
    await createQaClient({ enabled: () => true, context: () => otherWorkspace, mock: true }).create({ ...input, title: 'Match unrelated workspace' });
    const filters: QaListInput = { projectId: 'p1', states: ['new', 'triaged'], search: 'Match', mine: 'testing', limit: 1 };
    expect(await client.list(filters)).toMatchObject({ issues: [{ id: first.id }], total: 2, hasMore: true });
    expect(await client.list({ ...filters, offset: 1 })).toMatchObject({ issues: [{ id: last.id }], total: 2, hasMore: false });
    expect(await client.list({ ...filters, offset: 2 })).toEqual({ issues: [], total: 2, hasMore: false });
    expect((await client.list({ projectId: 'p1', states: ['new'] })).issues.map(issue => issue.id)).toEqual([untriaged.id]);
    expect((await client.list({ projectId: 'p1', state: 'dismissed' })).issues.map(issue => issue.id)).toEqual([closed.id]);
    const columns = getQaWorkflowColumns(DEFAULT_QA_WORKFLOW, state => state);
    const pages = await Promise.all(columns.map(column => client.list({ states: column.states })));
    pages.forEach((page, index) => expect(page.issues.every(issue => columns[index].states.includes(issue.state))).toBe(true));
    expect(pages.flatMap(page => page.issues).filter(issue => issue.id === first.id)).toHaveLength(1);
    expect(mocks.session).not.toHaveBeenCalled();
  });
  it.each([
    { states: [] }, { states: ['new', 'new'] }, { states: ['new', 'invalid'] }, { states: ['new,closed'] },
    { states: null }, { states: 'new' }, { state: 'new', states: ['new', 'triaged'] }, { state: 'invalid' },
  ])('rejects invalid or ambiguous demo state filters like both production adapters: %j', async filters => {
    const client = createQaClient({ enabled: () => true, context, mock: true });
    await expect(client.list(filters as QaListInput)).rejects.toMatchObject({ code: 'qa_invalid_state', status: 400 });
  });
  it.each([{ offset: -1 }, { offset: 1.5 }, { offset: 100001 }, { limit: 0 }, { limit: 101 }])('rejects invalid Docker-compatible demo pages: %j', async filters => {
    await expect(createQaClient({ enabled: () => true, context, mock: true }).list(filters)).rejects.toMatchObject({ code: 'qa_invalid_page', status: 400 });
  });
  it('forwards grouped states and pagination unchanged to the production endpoint', async () => {
    const fetchMock = vi.fn(async () => Response.json({ issues: [], total: 0, hasMore: false })); vi.stubGlobal('fetch', fetchMock);
    const filters: QaListInput = { states: ['new', 'triaged'], offset: 20, limit: 20 }, controller = new AbortController();
    await createQaClient({ enabled: () => true, context }).list(filters, controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/qa', expect.objectContaining({ signal: controller.signal, body: JSON.stringify({ action: 'list', input: filters }) }));
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
  it('passes the create abort signal and never submits an already aborted draft', async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: 'bug1' })); vi.stubGlobal('fetch', fetchMock);
    const client = createQaClient({ enabled: () => true, context }), controller = new AbortController();
    await client.create(input, 'bug1', 'command1', controller.signal);
    expect(fetchMock).toHaveBeenCalledWith('https://example.test/qa', expect.objectContaining({ signal: controller.signal,
      body: JSON.stringify({ action: 'create', id: 'bug1', commandId: 'command1', input }) }));
    controller.abort(); await expect(client.create(input, 'bug1', 'command1', controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('recovers a lost finalize response without allocating or uploading a second attachment', async () => {
    const actions: string[] = []; let lost = true;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); actions.push(body.action);
      if (body.action === 'upload_init') return Response.json({ id: 'up1', provider: 'supabase', bucket: 'qa-private', path: 'b/file', token: 'signed-token' });
      expect(body.uploadId).toBe('up1');
      if (lost) { lost = false; throw new TypeError('connection lost'); }
      return Response.json({ id: 'up1', issueId: 'bug1' });
    }));
    const client = createQaClient({ enabled: () => true, context }), resume: QaUploadResume = {};
    const file = new File(['video'], 'proof.mp4', { type: 'video/mp4' });
    await expect(client.upload('bug1', file, undefined, undefined, resume)).rejects.toThrow('connection lost');
    expect((await client.upload('bug1', file, undefined, undefined, resume)).id).toBe('up1');
    await client.upload('bug1', file, undefined, undefined, resume);
    expect(actions).toEqual(['upload_init', 'upload_complete', 'upload_complete']); expect(mocks.signedUpload).toHaveBeenCalledTimes(1);
  });
  it('does not reupload when a retry cannot establish whether finalize succeeded', async () => {
    const resume: QaUploadResume = { upload: { id: 'up1', provider: 'supabase', partSize: 0, bucket: 'qa-private', path: 'b/file', token: 'signed-token' } };
    const fetchMock = vi.fn(async () => { throw new TypeError('offline'); }); vi.stubGlobal('fetch', fetchMock);
    await expect(createQaClient({ enabled: () => true, context }).upload('bug1', new File(['proof'], 'proof.txt', { type: 'text/plain' }), undefined, undefined, resume)).rejects.toThrow('offline');
    expect(fetchMock).toHaveBeenCalledTimes(1); expect(mocks.signedUpload).not.toHaveBeenCalled(); expect(resume.upload?.id).toBe('up1');
  });
  it.each([true, false])('checks exact attachment identity before replacing an expired reservation (already completed=%s)', async completed => {
    const actions: string[] = [], resume: QaUploadResume = { upload: { id: 'up1', provider: 'supabase', partSize: 0 } };
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)); actions.push(body.action);
      if (body.action === 'upload_complete' && body.uploadId === 'up1') return Response.json({ error: { code: 'qa_upload_expired' } }, { status: 410 });
      if (body.action === 'get') return Response.json({ attachments: [{ id: completed ? 'up1' : 'different-id', fileName: 'proof.txt' }] });
      if (body.action === 'upload_init') return Response.json({ id: 'up2', provider: 'supabase', bucket: 'qa-private', path: 'b/new', token: 'signed-token' });
      return Response.json({ id: body.uploadId });
    }));
    const result = await createQaClient({ enabled: () => true, context }).upload('bug1', new File(['proof'], 'proof.txt', { type: 'text/plain' }), undefined, undefined, resume);
    expect(result.id).toBe(completed ? 'up1' : 'up2');
    expect(actions).toEqual(completed ? ['upload_complete', 'get'] : ['upload_complete', 'get', 'upload_init', 'upload_complete']);
    expect(mocks.signedUpload).toHaveBeenCalledTimes(completed ? 0 : 1);
  });
  it('resumes failed multipart uploads while retaining successful part identities', async () => {
    const actions: string[] = []; let fail = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.includes('upload_part')) {
        const part = new URL(url).searchParams.get('partNumber'); actions.push(`part${part}`);
        if (part === '2' && fail) { fail = false; throw new TypeError('offline'); }
        return Response.json({ etag: `etag-${part}` });
      }
      const body = JSON.parse(String(init.body)); actions.push(body.action);
      if (body.action === 'upload_init') return Response.json({ id: 'up1', provider: 'r2', partSize: 3 });
      if (body.parts.length === 1) return Response.json({ error: { code: 'qa_upload_incomplete' } }, { status: 409 });
      return Response.json({ id: 'up1' });
    }));
    const client = createQaClient({ enabled: () => true, context }), resume: QaUploadResume = {};
    const file = new File(['sixbyt'], 'proof.mp4', { type: 'video/mp4' });
    await expect(client.upload('bug1', file, undefined, undefined, resume)).rejects.toThrow('offline');
    await client.upload('bug1', file, undefined, undefined, resume);
    expect(actions).toEqual(['upload_init', 'part1', 'part2', 'upload_complete', 'part2', 'upload_complete']);
    expect(resume.parts).toEqual([{ partNumber: 1, etag: 'etag-1' }, { partNumber: 2, etag: 'etag-2' }]);
  });
  it('applies the actual deployment file rules and 200 MB boundary before starting requests', async () => {
    const file = new File(['proof'], 'proof.mp4', { type: 'video/mp4' });
    Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024, configurable: true });
    expect(qaValidateUploadFile(file)).toBeUndefined();
    Object.defineProperty(file, 'size', { value: 200 * 1024 * 1024 + 1 });
    expect(qaValidateUploadFile(file)).toBe('file_size');
    expect(qaValidateUploadFile(new File([], 'empty.txt', { type: 'text/plain' }))).toBe('file_size');
    expect(qaValidateUploadFile(new File(['svg'], 'image.svg', { type: 'image/svg+xml' }))).toBe('file_type');
    vi.stubEnv('VITE_API_URL', '');
    expect(qaValidateUploadFile(new File(['video'], 'proof.webm', { type: 'video/webm' }))).toBeUndefined();
    vi.stubEnv('VITE_API_URL', 'https://api.example.test');
    expect(qaValidateUploadFile(new File(['video'], 'proof.webm', { type: 'video/webm' }))).toBe('file_type');
    expect(qaValidateUploadFile(new File(['image'], 'wrong.pdf', { type: 'image/png' }))).toBe('file_type');
    expect(qaValidateUploadFile(new File(['{}'], 'data.json', { type: 'application/json' }))).toBeUndefined();
    expect(qaValidateUploadFile(new File(['a'], '../proof.txt', { type: 'text/plain' }))).toBe('file_name');
    const fetchMock = vi.fn(); vi.stubGlobal('fetch', fetchMock);
    await expect(createQaClient({ enabled: () => true, context }).upload('bug1', file)).rejects.toMatchObject({ code: 'file_size' });
    expect(fetchMock).not.toHaveBeenCalled();
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
