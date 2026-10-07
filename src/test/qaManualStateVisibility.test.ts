import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
import { createQaClient } from '@/lib/qa/client';
import { QA_STATES, type QaActor, type QaContext } from '@/lib/qa/domain';
import { DEFAULT_QA_WORKFLOW } from '@/lib/qa/workflow';
import { defaultQaManualStateVisibility, getQaManualStateChoices, parseQaManualStateVisibility, validateQaManualStateVisibility } from '@/lib/qa/manualStateVisibility';
const context = (actor: QaActor, workspaceId = 'visibility-example'): QaContext => ({ actor, workspaceId, now: '2026-10-07T00:00:00.000Z', newId: () => 'example-id', memberIds: new Set(['example-member']), projectIds: new Set(), taskIds: new Set(), environmentValues: [] });
const client = (actor: QaActor, workspaceId?: string) => createQaClient({ mock: true, enabled: () => true, context: () => context(actor, workspaceId) });
describe('manual QA state visibility is a scoped presentation preference', () => {
  it('shows all eight choices by default and cannot mutate a shared default', () => {
    const first = defaultQaManualStateVisibility(); first.hiddenStates.push('closed');
    expect(getQaManualStateChoices(DEFAULT_QA_WORKFLOW, defaultQaManualStateVisibility())).toEqual(QA_STATES);
  });
  it('hides only the configured choices while preserving workflow, PASS and closing state IDs', () => {
    const before = JSON.stringify(DEFAULT_QA_WORKFLOW);
    const configuration = validateQaManualStateVisibility({ version: 1, hiddenStates: ['closed', 'triaged'] });
    expect(getQaManualStateChoices(DEFAULT_QA_WORKFLOW, configuration)).toEqual(['new', 'in_progress', 'verification', 'verified', 'failed', 'dismissed']);
    expect(JSON.stringify(DEFAULT_QA_WORKFLOW)).toBe(before);
    expect(DEFAULT_QA_WORKFLOW.order).toContain('closed');
    expect(getQaManualStateChoices(DEFAULT_QA_WORKFLOW, configuration)).toContain('verified');
  });
  it.each([null, false, '{broken', {}, { version: 2, hiddenStates: [] }, { version: 1, hiddenStates: ['unknown'] },
    { version: 1, hiddenStates: ['closed', 'closed'] }, { version: 1, hiddenStates: [], extra: true }, { version: 1, hiddenStates: 'closed' }])('invalid stored display values restore all choices: %j', value => {
    expect(parseQaManualStateVisibility(value)).toEqual({ version: 1, hiddenStates: [] });
  });
  it.each([{ version: 1, hiddenStates: ['unknown'] }, { version: 1, hiddenStates: ['closed', 'closed'] }, { version: 1, hiddenStates: [], extra: true }])('rejects malformed explicit writes: %j', value => {
    expect(() => validateQaManualStateVisibility(value)).toThrow('qa_invalid_manual_state_visibility');
  });
  it('ordinary members cannot write the preference', async () => {
    await expect(client({ id: 'example-member', role: 'member' }).saveManualStateVisibility({ version: 1, hiddenStates: ['closed'] })).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  });
  it.each([{ role: 'admin' as const }, { role: 'super_admin' as const }, { role: 'member' as const, qaAdmin: true }])('preserves existing QA configuration capability: %j', async capability => {
    const api = client({ id: 'example-member', ...capability }, 'visibility-capability-' + capability.role + '-' + !!capability.qaAdmin);
    expect(await api.saveManualStateVisibility({ version: 1, hiddenStates: ['triaged', 'closed'] })).toEqual({ version: 1, hiddenStates: ['triaged', 'closed'] });
    expect(await api.getManualStateVisibility()).toEqual({ version: 1, hiddenStates: ['triaged', 'closed'] });
  });
  it('preferences in one workspace never change another', async () => {
    const actor: QaActor = { id: 'example-member', role: 'admin' };
    await client(actor, 'visibility-workspace-a').saveManualStateVisibility({ version: 1, hiddenStates: ['closed'] });
    expect(await client(actor, 'visibility-workspace-b').getManualStateVisibility()).toEqual({ version: 1, hiddenStates: [] });
  });
  it('a revoked or unavailable member cannot write even with an admin role', async () => {
    const ctx = { ...context({ id: 'example-member', role: 'admin' }), memberIds: new Set<string>() };
    const api = createQaClient({ mock: true, enabled: () => true, context: () => ctx });
    await expect(api.saveManualStateVisibility({ version: 1, hiddenStates: [] })).rejects.toMatchObject({ code: 'qa_forbidden' });
  });
});
