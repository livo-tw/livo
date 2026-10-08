import { describe, expect, it, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ USING_MOCK_BACKEND: true, supabase: {} }));
import { createQaClient } from '@/lib/qa/client';
import { QA_STATES, type QaActor, type QaContext } from '@/lib/qa/domain';
import { defaultQaDisplaySettings, getQaBoardStates, getQaPriorityChoices, parseQaDisplaySettings, validateQaDisplaySettings } from '@/lib/qa/displaySettings';

const configured = { version: 1 as const, showSeverity: false, hiddenPriorityChoices: [1, 5], hiddenBoardStates: ['triaged', 'closed'] as typeof QA_STATES };
const context = (actor: QaActor, workspaceId: string): QaContext => ({ actor, workspaceId, now: '2026-10-08T00:00:00Z', newId: () => 'example-id',
  memberIds: new Set(['example-actor']), projectIds: new Set(), taskIds: new Set(), environmentValues: [] });
describe('workspace QA display preferences', () => {
  it('returns independent public defaults and canonicalizes valid choices', () => {
    const first = defaultQaDisplaySettings(); first.hiddenBoardStates.push('new');
    expect(defaultQaDisplaySettings()).toEqual({ version: 1, showSeverity: true, hiddenPriorityChoices: [], hiddenBoardStates: [] });
    expect(validateQaDisplaySettings({ ...configured, hiddenPriorityChoices: [5, 1], hiddenBoardStates: ['closed', 'triaged'] })).toEqual(configured);
  });
  it.each([
    null, [], {}, { ...configured, extra: true }, { ...configured, showSeverity: 'false' },
    { ...configured, version: '1' }, { ...configured, hiddenPriorityChoices: [0] },
    { ...configured, hiddenPriorityChoices: [1.5] }, { ...configured, hiddenPriorityChoices: [1, 1] },
    { ...configured, hiddenPriorityChoices: [1, 2, 3, 4, 5] }, { ...configured, hiddenBoardStates: ['unknown'] },
    { ...configured, hiddenBoardStates: ['new', 'new'] }, { ...configured, hiddenBoardStates: QA_STATES },
  ])('rejects malformed configurations without changing public defaults', value => {
    expect(() => validateQaDisplaySettings(value)).toThrow('qa_invalid_display_settings');
    expect(parseQaDisplaySettings(value)).toEqual(defaultQaDisplaySettings());
  });
  it('retains a hidden historical priority as the current editing value', () => {
    expect(getQaPriorityChoices(configured)).toEqual([2, 3, 4]);
    expect(getQaPriorityChoices(configured, 1)).toEqual([1, 2, 3, 4]);
    expect(getQaPriorityChoices(configured, 5)).toEqual([2, 3, 4, 5]);
  });
  it('hides default columns while explicit filters can retrieve history', () => {
    const original = [...QA_STATES];
    expect(getQaBoardStates(configured, QA_STATES)).not.toContain('closed');
    expect(getQaBoardStates(configured, QA_STATES, ['triaged', 'closed'])).toEqual(['triaged', 'closed']);
    expect(QA_STATES).toEqual(original);
  });
  it.each(['member', 'admin'] as const)('rejects %s including a QA administrator', async role => {
    const api = createQaClient({ enabled: () => true, mock: true, context: () => context({ id: 'example-actor', role, qaAdmin: true }, 'display-forbidden-' + role) });
    await expect(api.saveDisplaySettings(configured)).rejects.toMatchObject({ code: 'qa_forbidden', status: 403 });
  });
  it('reads back saved settings and scopes them to one workspace', async () => {
    const actor: QaActor = { id: 'example-actor', role: 'super_admin' };
    const a = createQaClient({ enabled: () => true, mock: true, context: () => context(actor, 'display-a') });
    const b = createQaClient({ enabled: () => true, mock: true, context: () => context(actor, 'display-b') });
    expect(await a.saveDisplaySettings(configured)).toEqual(configured);
    expect(await a.getDisplaySettings()).toEqual(configured);
    expect(await b.getDisplaySettings()).toEqual(defaultQaDisplaySettings());
  });
  it('rejects an inactive demo caller and disabled feature without saving', async () => {
    const ctx = context({ id: 'example-actor', role: 'super_admin' }, 'display-inactive');
    ctx.memberIds = new Set();
    const inactive = createQaClient({ enabled: () => true, mock: true, context: () => ctx });
    await expect(inactive.saveDisplaySettings(configured)).rejects.toMatchObject({ code: 'qa_forbidden' });
    const disabled = createQaClient({ enabled: () => false, mock: true, context: () => ctx });
    await expect(disabled.getDisplaySettings()).rejects.toMatchObject({ code: 'qa_disabled' });
  });
});
