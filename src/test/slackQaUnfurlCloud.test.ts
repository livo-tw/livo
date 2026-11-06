// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ query: vi.fn(), live: vi.fn(), slack: vi.fn() }));
vi.mock('../../worker/src/db', () => ({ runQuery: mocks.query }));
vi.mock('../../worker/src/liveMember', () => ({ liveMember: mocks.live }));
vi.mock('../../worker/src/qaSlackSync', () => ({ qaSlackClient: () => mocks.slack }));
// The worker is typechecked with its Cloudflare configuration, not the DOM app's.
const WORKER_UNFURL = '../../worker/src/taskUnfurl';
const { createCloudTaskUnfurlActions } = await import(/* @vite-ignore */ WORKER_UNFURL);
import { DEFAULT_QA_WORKFLOW } from '../lib/qa/workflow';

const id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const project = { id: 'project-example', name: 'Example project', line_id: 'line-example', is_archived: false };
const auth = { userId: 'auth-example', member: { id: 'member-example', workspaceId: 'workspace-example' } };
const actor = { id: 'member-example', role: 'member', auth, locale: 'en' };
function fixture() {
  const qa = { api: vi.fn(async (_actor: unknown, body: Record<string, unknown>): Promise<any> => body.action === 'get'
    ? { issue: { id, projectId: project.id, title: 'Example QA', state: 'verification', assigneeId: 'fixer', qaOwnerId: null, priority: 2, severity: 'major' },
        memberNames: { fixer: 'Example fixer' } }
    : { ...DEFAULT_QA_WORKFLOW, labels: { ...DEFAULT_QA_WORKFLOW.labels, verification: 'Custom verification' } }) };
  const a = createCloudTaskUnfurlActions({} as never, 'workspace-example', {} as never, vi.fn(), qa);
  return { a, qa };
}
beforeEach(() => {
  vi.clearAllMocks(); mocks.live.mockResolvedValue(true);
  mocks.query.mockResolvedValue({ data: [project] });
});
describe('Cloud QA unfurl normal caller reads', () => {
  it('uses the verified actor QA API and workspace query engine instead of privileged issue reads', async () => {
    const { a, qa } = fixture(), card = await a.qaCard!(actor, id);
    expect(qa.api).toHaveBeenCalledWith(actor, { action: 'get', id });
    expect(qa.api).toHaveBeenCalledWith(actor, { action: 'get_workflow' });
    expect(mocks.query).toHaveBeenCalledWith(expect.anything(), expect.anything(), auth,
      expect.objectContaining({ table: 'projects', filters: [{ col: 'id', op: 'eq', val: project.id }] }));
    expect(card).toMatchObject({ stateLabel: 'Custom verification', assigneeName: 'Example fixer' });
    expect(mocks.query.mock.calls.every(call => call[3].table === 'projects')).toBe(true);
  });
  it('rejects a caller from another workspace without reading QA', async () => {
    const { a, qa } = fixture();
    expect(await a.qaCard!({ ...actor, auth: { ...auth, member: { ...auth.member, workspaceId: 'other-workspace' } } }, id)).toBeUndefined();
    expect(qa.api).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('checks the live member gate before reading QA', async () => {
    const { a, qa } = fixture(); mocks.live.mockResolvedValue(false);
    expect(await a.qaCard!(actor, id)).toBeUndefined(); expect(qa.api).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404])('does not fall back after a denied QA request (%s)', async status => {
    const { a, qa } = fixture(); qa.api.mockRejectedValue(Object.assign(new Error('qa_forbidden'), { status }));
    expect(await a.qaCard!(actor, id)).toBeUndefined(); expect(mocks.query).not.toHaveBeenCalled();
  });
  it('requires the caller to read the current project as well', async () => {
    const { a } = fixture(); mocks.query.mockResolvedValue({ data: [] });
    expect(await a.qaCard!(actor, id)).toBeUndefined();
  });
});
