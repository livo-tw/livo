import { describe, expect, it, vi } from 'vitest';
import { handleKnowledgeSlack, isKnowledgeSlackPayload, knowledgeResultsModal, knowledgeSearchModal,
  normalizeKnowledgeSearch, type KnowledgeSlackActions } from '@/lib/knowledgeSlack';

function adapter() {
  const jobs: Promise<unknown>[] = [];
  const slack = vi.fn(async (method: string) => ({ view: { id: 'example-view', hash: method === 'views.open' ? 'example-hash' : 'new-hash' } }));
  const actions: KnowledgeSlackActions = {
    enabled: vi.fn(async () => true), actor: vi.fn(async () => ({ id: 'example-member', locale: 'en' })),
    search: vi.fn(async (_actor, query) => ({ pages: [{ id: 'example-page', title: '<Example & guide>', category: 'general',
      body: 'must never be sent', attachment_url: 'must never be sent', access_policy: { mode: 'custom' } }], hasMore: false, page: query.page })),
    link: page => `https://example.com/?kb=${page.id}`, slack, background: job => { jobs.push(job); },
  };
  return { actions, slack, finish: () => Promise.all(jobs) };
}
const command = { command: '/livo', text: 'kb release', trigger_id: 'example-trigger', user_id: 'UDEMO', team_id: 'TDEMO' };
describe('private Slack knowledge search', () => {
  it('keeps existing task and QA commands outside the knowledge dispatcher', () => {
    for (const text of ['search release', 'bug new example', 'KB-123', 'my']) expect(isKnowledgeSlackPayload({ ...command, text })).toBe(false);
    expect(isKnowledgeSlackPayload(command)).toBe(true);
    expect(isKnowledgeSlackPayload({ type: 'message_action', callback_id: 'livo_search_knowledge' })).toBe(true);
  });
  it('normalizes bounded queries without interpreting punctuation as query syntax', () => {
    expect(normalizeKnowledgeSearch({ text: " ＡＰＩ 'guide' ", page: -1, category: 'meeting' })).toEqual({ text: "API 'guide'", page: 0, category: 'meeting' });
    expect(() => normalizeKnowledgeSearch({ text: 'a'.repeat(101) })).toThrow();
    expect(() => normalizeKnowledgeSearch({ text: '' })).toThrow();
  });
  it('acknowledges before a slow identity lookup, then presents only a private modal', async () => {
    const a = adapter(); let release!: (value: Record<string, unknown>) => void;
    a.actions.actor = vi.fn(() => new Promise(resolve => { release = resolve; }));
    expect(await handleKnowledgeSlack(command, a.actions)).toEqual({});
    await Promise.resolve(); release({ id: 'example-member', locale: 'en' }); await a.finish();
    expect(a.slack.mock.calls.map(call => call[0])).toEqual(['views.open', 'views.update']);
    const payload = JSON.stringify(a.slack.mock.calls);
    expect(payload).toContain('Open in LIVO'); expect(payload).toContain('&lt;Example &amp; guide&gt;');
    expect(payload).not.toContain('must never be sent'); expect(payload).not.toContain('access_policy');
    expect(payload).not.toContain('chat.post'); expect(payload).not.toContain('conversations.open');
  });
  it('fails closed without falling back to public, ephemeral or DM document delivery', async () => {
    const a = adapter(); a.actions.search = vi.fn(async () => { throw new Error('example database detail'); });
    await handleKnowledgeSlack(command, a.actions); await a.finish();
    const payload = JSON.stringify(a.slack.mock.calls);
    expect(payload).not.toContain('example database detail');
    expect(a.slack.mock.calls.every(call => ['views.open', 'views.update'].includes(call[0]))).toBe(true);
  });
  it('does not query while a selected message is merely being previewed', async () => {
    const a = adapter(); await handleKnowledgeSlack({ ...command, command: undefined, type: 'message_action',
      callback_id: 'livo_search_knowledge', message: { text: 'Release rules <@UEXAMPLE>' } }, a.actions); await a.finish();
    expect(a.actions.search).not.toHaveBeenCalled(); expect(JSON.stringify(a.slack.mock.calls)).toContain('initial_value');
  });
  it('rechecks actor on pagination and derives it from the Slack request, not button metadata', async () => {
    const a = adapter(); await handleKnowledgeSlack({ type: 'block_actions', user: { id: 'UDEMO' }, team: { id: 'TDEMO' },
      view: { id: 'example-view', hash: 'example-hash', private_metadata: '{"user":"OTHER"}' },
      actions: [{ action_id: 'livo_kb_page', value: JSON.stringify({ text: 'release', page: 1, category: 'general', actor: 'OTHER' }) }] }, a.actions);
    await a.finish(); expect(a.actions.actor).toHaveBeenCalledOnce();
    expect(a.actions.search).toHaveBeenCalledWith(expect.objectContaining({ id: 'example-member' }), { text: 'release', page: 1, category: 'general' });
  });
  it('returns field errors for invalid submission without querying', async () => {
    const a = adapter(); const result = await handleKnowledgeSlack({ type: 'view_submission', view: { callback_id: 'livo_kb_search', state: { values: {} } } }, a.actions);
    expect(result?.response_action).toBe('errors'); expect(a.actions.actor).not.toHaveBeenCalled();
  });
  it.each(['zh-TW', 'zh-CN', 'en'])('has localized form labels and no hidden-result counters (%s)', locale => {
    const view = knowledgeSearchModal(command, locale); expect(view.submit.text).toBeTruthy();
    const result = knowledgeResultsModal(command, { text: 'rules', page: 0, category: 'all' }, { pages: [], hasMore: false, page: 0 }, () => '', locale);
    expect(JSON.stringify(result)).not.toMatch(/hidden|受限.*\d/); expect(result.type).toBe('modal');
  });
});
