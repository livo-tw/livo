import { describe, expect, it, vi } from 'vitest';
import { createKnowledgeData, handleKnowledgeInteraction, knowledgePreview, knowledgeResultsModal,
  knowledgeSearchModal } from '../../docker/volumes/functions/slack-interact/knowledge-workspace';
import { homeModal } from '../../docker/volumes/functions/slack-interact/workspace-ui';
import { handleInteraction, type Actions } from '../../docker/volumes/functions/slack-interact/handler';
import type { Row } from '../../docker/volumes/functions/slack-interact/core';

const actor = { id: 'member-example', jwt: 'example-member-session', locale: 'en' };
const source = { channel: 'CEXAMPLE', user: 'UEXAMPLE', locale: 'en' };
const page = { id: 'kb-example', title: 'Release guide', body: '<p>Check the build.</p>', version: 3, updated_at: '2026-10-03' };
function harness(rows: Row[] = []) {
  const read = vi.fn(async () => rows), memberDb = vi.fn(() => ({ rows: read, request: vi.fn() }));
  return { data: createKnowledgeData(memberDb, 'http://example.com/'), read, memberDb };
}
function actions(knowledge = harness([page]).data) {
  const work: Promise<unknown>[] = [];
  const slack = vi.fn(async (method: string, _body: Row) => method === 'views.open' ? { view: { id: 'view-example', hash: 'hash-example' } } : {});
  const d = { knowledge, enabled: vi.fn(async () => true), actor: vi.fn(async () => actor), slack,
    background: (job: Promise<unknown>) => work.push(job), reply: vi.fn() } as unknown as Actions;
  return { d, slack, work };
}

describe('private Slack knowledge reads', () => {
  it('uses the requesting member for every query and never fetches content in result lists', async () => {
    const h = harness(Array.from({ length: 9 }, (_, index) => ({ ...page, id: `kb-${index}` })));
    const result = await h.data.search(actor, 'release', 2);
    expect(h.memberDb).toHaveBeenCalledWith(actor);
    expect(h.read).toHaveBeenCalledWith('kb_pages', expect.objectContaining({
      select: 'id,title,category,version,updated_at', is_archived: 'eq.false',
      order: 'title.asc,id.asc', limit: '9', offset: '16',
    }));
    expect(result.pages).toHaveLength(8); expect(result.hasMore).toBe(true);
  });
  it('rechecks permission on open, and revoked or administrator-restricted access returns the same unavailable error', async () => {
    const h = harness();
    for (const role of ['member', 'admin', 'super_admin']) {
      await expect(h.data.detail({ ...actor, role }, page.id)).rejects.toThrow('文件不存在或你沒有檢視權限。');
    }
    expect(h.read).toHaveBeenCalledTimes(3);
    expect(h.read).toHaveBeenCalledWith('kb_pages', expect.objectContaining({ id: 'eq.kb-example', is_archived: 'eq.false' }));
  });
  it('rejects forged ids before database access and bounds hostile search/pagination inputs', async () => {
    const h = harness();
    await expect(h.data.detail(actor, 'kb-a,or(id.neq.null)')).rejects.toThrow(); expect(h.read).not.toHaveBeenCalled();
    await h.data.search(actor, 'file*,id.neq.null', -1);
    expect(h.read).toHaveBeenLastCalledWith('kb_pages', expect.objectContaining({ or: '(title.ilike.*fileidneqnull*,body.ilike.*fileidneqnull*)', offset: '0' }));
    await expect(h.data.search(actor, '<>,.*')).rejects.toThrow();
  });
  it('provides a root-safe encoded link without a fixed demo path', () => {
    expect(harness().data.link(page)).toBe('http://example.com/?knowledge=kb-example');
  });
});

describe('knowledge Slack views and ACK behavior', () => {
  it('dispatches the new certified search and existing document preview through separate adapters', async () => {
    const h = actions();
    const certifiedSearch = vi.fn(async () => ({ pages: [page], hasMore: false, page: 0 }));
    h.d.knowledgeSearch = { enabled: h.d.enabled, actor: h.d.actor, search: certifiedSearch,
      slack: h.d.slack, background: h.d.background, link: p => `https://example.com/?kb=${p.id}` };
    const legacyDetail = vi.spyOn(h.d.knowledge!, 'detail');
    await handleInteraction({ command: '/livo', text: 'kb release', trigger_id: 'new-search',
      team_id: 'TEXAMPLE', user_id: 'UEXAMPLE' }, 'new-envelope', h.d);
    await Promise.all(h.work);
    expect(certifiedSearch).toHaveBeenCalledWith(actor, expect.objectContaining({ text: 'release' }));
    expect(legacyDetail).not.toHaveBeenCalled();
    await handleInteraction({ type: 'block_actions', trigger_id: 'legacy-open', user: { id: 'UEXAMPLE' },
      team: { id: 'TEXAMPLE' }, actions: [{ action_id: 'livo_knowledge_open', value: JSON.stringify({ id: page.id }) }] }, 'legacy-envelope', h.d);
    await Promise.all(h.work);
    expect(legacyDetail).toHaveBeenCalledWith(actor, page.id);
    expect(certifiedSearch).toHaveBeenCalledTimes(1);
  });

  it('makes QA and knowledge operations discoverable from the existing task home', () => {
    const text = JSON.stringify(homeModal(source));
    expect(text).toContain('livo_knowledge_search'); expect(text).toContain('livo_qa_workspace_list');
    expect(text).toContain('livo_qa_workspace_my');
  });
  it.each(['zh-TW', 'zh-CN', 'en'])('builds private forms and pagination in %s', locale => {
    const query = knowledgeSearchModal({ ...source, locale });
    expect(query.callback_id).toBe('livo_search_knowledge');
    expect(JSON.parse(query.private_metadata)).toEqual({ channel: 'CEXAMPLE', user: 'UEXAMPLE', locale });
    const result = knowledgeResultsModal({ pages: [page], page: 1, hasMore: true, query: 'guide' }, { ...source, locale });
    const nav = result.blocks.flatMap((block: Row) => block.elements || []).filter((item: Row) => item.action_id === 'livo_knowledge_page');
    expect(nav.map((item: Row) => JSON.parse(item.value).page)).toEqual([0, 2]);
  });
  it('shows bounded plain text, strips executable/embedded content and explicitly labels partial previews', () => {
    const view = knowledgePreview({ ...page, body: '<script>privateScript()</script><img src="https://example.com/private-file"><p>&lt;@here&gt;' + 'x'.repeat(4000) + '</p>' }, 'http://example.com/', source);
    const json = JSON.stringify(view);
    expect(json).not.toContain('privateScript'); expect(json).not.toContain('private-file');
    expect(view.blocks[2].text.type).toBe('plain_text'); expect(view.blocks[2].text.text.length).toBe(2800);
    expect(json).toContain('partial preview');
  });
  it('ACKs before a slow actor lookup and only updates the private modal', async () => {
    const h = actions();
    let resolve!: (value: typeof actor) => void;
    h.d.actor = vi.fn(() => new Promise<typeof actor>(done => { resolve = done; }));
    expect(await handleKnowledgeInteraction({ command: '/livo', text: 'kb release', trigger_id: 'trigger-example' }, h.d, source)).toEqual({});
    expect(h.slack.mock.calls[0][0]).toBe('views.open'); resolve(actor); await Promise.all(h.work);
    expect(h.slack.mock.calls.at(-1)?.[0]).toBe('views.update'); expect(h.d.reply).not.toHaveBeenCalled();
  });
  it('validates missing keywords within the submission ACK and does not query or mutate', async () => {
    const h = actions();
    const result = await handleKnowledgeInteraction({ type: 'view_submission', view: { callback_id: 'livo_search_knowledge', state: { values: {} } } }, h.d, source);
    expect(result).toEqual({ response_action: 'errors', errors: { query: 'Enter a document title or content keyword.' } });
    expect(h.d.actor).not.toHaveBeenCalled(); expect(h.slack).not.toHaveBeenCalled();
  });
  it('recognizes the explicit kb search verb without treating it as a keyword', async () => {
    const h = actions();
    await handleKnowledgeInteraction({ command: '/livo', text: 'kb search', trigger_id: 'trigger-example' }, h.d, source);
    await Promise.all(h.work);
    expect(h.slack.mock.calls.at(-1)?.[1]).toEqual(expect.objectContaining({ view: expect.objectContaining({ callback_id: 'livo_search_knowledge' }) }));
  });
  it('does not leak content or an upstream failure to a channel when a private update fails', async () => {
    const h = actions();
    h.d.knowledge!.detail = vi.fn(async () => { throw new Error('private SQL details'); });
    h.d.slack = vi.fn(async (method: string) => {
      if (method === 'views.update') throw new Error('closed');
      return { view: { id: 'view-example' } };
    });
    await handleKnowledgeInteraction({ type: 'block_actions', trigger_id: 'trigger-example', actions: [{ action_id: 'livo_knowledge_open', value: '{"id":"kb-example"}' }] }, h.d, source);
    await Promise.all(h.work); expect(h.d.reply).not.toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(h.d.slack).mock.calls)).not.toContain('private SQL details');
  });
  it('does not intercept task search or an unrelated callback', async () => {
    const h = actions();
    expect(await handleKnowledgeInteraction({ command: '/livo', text: 'search release' }, h.d, source)).toBeUndefined();
    expect(await handleKnowledgeInteraction({ type: 'view_submission', view: { callback_id: 'livo_edit_task' } }, h.d, source)).toBeUndefined();
  });
});
