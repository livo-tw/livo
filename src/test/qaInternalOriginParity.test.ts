// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQaService } from '../../docker/volumes/functions/qa/service';
import { applyQaCommand, canQaDelete, createQaIssue, qaNotificationRecipients, type QaContext, type QaIssue } from '../lib/qa/domain';
import { buildMyAssignments } from '../lib/myAssignments';

vi.mock('../../docker/volumes/functions/qa/slackSync.ts', () => ({ syncQaSlackIssue: vi.fn() }));

const reporters = ['reporter-example', 'eqa-reporter-example'] as const;
const when = '2026-11-09T01:00:00.000Z';
function context(actor = 'rd-example', role = 'member'): QaContext {
  let serial = 0;
  return { actor: { id: actor, role }, workspaceId: 'default', now: when,
    newId: () => `generated-${++serial}`, memberIds: new Set([...reporters, 'rd-example', 'qa-example', 'other-example']),
    projectIds: new Set(['project-example']), taskIds: new Set(), environmentValues: ['Stage'] };
}
function reported(reporterId: string) {
  return createQaIssue({ projectId: 'project-example', title: 'Example issue', actual: 'Example observation',
    observedEnvironment: 'Stage', assigneeId: 'rd-example', qaOwnerId: 'qa-example' }, 'issue-example', context(reporterId));
}
const normalized = (issue: QaIssue) => ({ ...issue, reporterId: 'reporter-normalized' });
function lifecycle(reporter: string) {
  const initial = reported(reporter);
  const started = applyQaCommand(initial, { type: 'start_fix' }, context());
  const submitted = applyQaCommand(started, { type: 'submit_fix', summary: 'Example repair',
    targets: [{ environment: 'Stage', component: 'API', build: 'example-build', required: true }] }, context());
  const targetId = submitted.targets[0].id;
  const verify = { type: 'record_verification' as const, targetId, build: 'example-build', result: 'pass' as const, note: '' };
  expect(() => applyQaCommand(submitted, verify, context('qa-example'))).toThrow('qa_not_deployed');
  expect(() => applyQaCommand(submitted, verify, context())).toThrow('qa_forbidden');
  const deployed = applyQaCommand(submitted, { type: 'record_deployment', targetId, build: 'example-build', evidence: '' }, context());
  const closed = applyQaCommand(deployed, verify, context('qa-example'));
  return [initial, started, submitted, deployed, closed];
}

describe('Internal QA operations are independent of reporter account origin', () => {
  it('executes the same real repair, deployment, verification and automatic closure transitions', () => {
    const [internal, external] = reporters.map(lifecycle);
    expect(external.map(normalized)).toEqual(internal.map(normalized));
    for (const path of [internal, external]) {
      expect(path.map(issue => issue.state)).toEqual(['new', 'in_progress', 'verification', 'verification', 'closed']);
      expect(path[path.length - 1]).toMatchObject({ resolution: 'fixed', closedBy: 'qa-example', closedAt: when, version: 5,
        runs: [expect.objectContaining({ testerId: 'qa-example', result: 'pass', fixCycle: 1 })] });
    }
  });

  it.each(['member', 'admin', 'super_admin'])('keeps internal %s command and deletion boundaries independent of origin', role => {
    const outcomes = reporters.map(reporter => {
      const issue = reported(reporter), actor = context('other-example', role);
      const edit = () => applyQaCommand(issue, { type: 'edit', title: 'Edited example', actual: issue.actual,
        steps: '', expected: '', observedEnvironment: 'Stage', observedVersion: '', component: '' }, actor);
      if (role === 'member') expect(edit).toThrow('qa_forbidden');
      else expect(edit().title).toBe('Edited example');
      return canQaDelete(issue, actor.actor);
    });
    expect(outcomes).toEqual(role === 'member' ? [false, false] : [true, true]);
  });

  it('keeps internal assignments and actionable notification recipients equivalent', () => {
    const [internal, external] = reporters.map(lifecycle);
    for (const member of ['rd-example', 'qa-example']) {
      const assignments = [internal, external].map(path => path.map(issue => buildMyAssignments([], [], [issue], member)
        .map(item => ({ ...item, issue: normalized(item.issue!) }))));
      expect(assignments[1]).toEqual(assignments[0]);
      expect(assignments[0][assignments[0].length - 1]).toEqual([]);
    }
    for (const type of ['create', 'submit_fix', 'record_deployment', 'record_verification'] as const) {
      expect(qaNotificationRecipients(external[2], type, 'rd-example')).toEqual(qaNotificationRecipients(internal[2], type, 'rd-example'));
    }
  });

  it.each(['member', 'admin', 'super_admin'])('allows the same internal %s detail and private attachment reads', async role => {
    let current = reported(reporters[0]);
    const calls: string[] = [];
    const authId = '11111111-1111-4111-8111-111111111111';
    const attachment = { id: 'attachment-example', issue_id: current.id, uploaded_by: reporters[1], file_name: 'example.txt',
      mime_type: 'text/plain', size: 7, storage_path: `default/${current.id}/attachment-example`, created_at: when };
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input), path = url.pathname;
      calls.push(path);
      const json = (value: unknown) => Response.json(value);
      if (path === '/auth/v1/user') return json({ id: authId, user_metadata: {}, app_metadata: {} });
      if (path === '/rest/v1/system_settings') return json([{ value: { qa: true } }]);
      if (path === '/rest/v1/members') return json(url.searchParams.has('auth_id')
        ? [{ id: 'rd-example', auth_id: authId, role, is_active: true, is_qa_admin: false }]
        : [{ id: 'rd-example', name: 'Example engineer' }, { id: 'qa-example', name: 'Example tester' },
          { id: reporters[0], name: 'Example internal reporter' }]
          .filter(person => (url.searchParams.get('id') || '').includes(person.id)));
      if (path === '/rest/v1/external_qa_accounts') return json([{ id: reporters[1], name: 'Example external reporter' }]
        .filter(person => (url.searchParams.get('id') || '').includes(person.id)));
      if (path === '/rest/v1/qa_issues') return json([{ data: current }]);
      if (path === '/rest/v1/projects') return json([{ id: current.projectId, name: 'Example project', is_archived: false }]);
      if (['/rest/v1/qa_comments', '/rest/v1/qa_events', '/rest/v1/qa_project_coordination'].includes(path)) return json([]);
      if (path === '/rest/v1/qa_attachments') return json([attachment]);
      if (path === '/rest/v1/rpc/livo_qa_attachment_for_download') {
        expect(init.method).toBe('POST');
        const body = JSON.parse(String(init.body));
        // The service resolves the actual active login; the RPC only returns an attachment in its authorized issue.
        if (body.p_auth_id !== authId) return Response.json({ code: '42501', message: 'qa_forbidden' }, { status: 403 });
        if (body.p_attachment_id !== attachment.id || attachment.issue_id !== current.id || !context().projectIds.has(current.projectId)) {
          return Response.json({ code: 'P0002', message: 'qa_attachment_not_found' }, { status: 404 });
        }
        return json(attachment);
      }
      if (path === `/storage/v1/object/authenticated/qa-evidence/${attachment.storage_path}`) return new Response('example');
      throw new Error(`Unexpected request: ${init.method || 'GET'} ${path}`);
    }));
    const settings: Record<string, string> = { SUPABASE_URL: 'http://backend.example.com', SUPABASE_ANON_KEY: 'example-anon', SUPABASE_SERVICE_ROLE_KEY: 'example-service' };
    const service = createQaService({ get: name => settings[name] }, 'example-session');
    for (const reporter of reporters) {
      current = reported(reporter);
      const detail = await service.handle({ action: 'get', id: current.id });
      expect(normalized(detail.issue)).toEqual(normalized(reported(reporters[0])));
      expect(detail.attachments[0].id).toBe(attachment.id);
      const response = await service.handle({ action: 'download', attachmentId: attachment.id }) as Response;
      expect(await response.text()).toBe('example');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    const priorStorageReads = calls.filter(path => path.startsWith('/storage/')).length;
    await expect(service.handle({ action: 'download', attachmentId: 'another-issue-attachment' })).rejects.toMatchObject({ code: 'qa_attachment_not_found', status: 404 });
    expect(calls.filter(path => path.startsWith('/storage/'))).toHaveLength(priorStorageReads);
    expect(calls.filter(path => path === '/rest/v1/rpc/livo_qa_attachment_for_download')).toHaveLength(3);
    expect(calls.some(path => path.includes('external_read'))).toBe(false);
  });
});

afterEach(() => vi.unstubAllGlobals());
