import { describe, expect, it } from 'vitest';
import { buildKnowledgeTree, knowledgeSnippet, knowledgeText, searchKnowledge, validateKnowledgeTree } from '@/lib/knowledge';
import { latestKnowledgeRevisions } from '../../worker/src/knowledgeModel';
import { seedKnowledgeMock, knowledgeMockUpdate } from '@/integrations/supabase/knowledgeMock';
import type { KnowledgePage } from '@/types/knowledge';

const page = (id: string, patch: Partial<KnowledgePage> = {}): KnowledgePage => ({ id, title: id, body: '',
  parent_id: null, project_id: null, sort_order: 0, is_archived: false, admin_only: false,
  created_by: 'member-a', updated_by: 'member-a', created_at: '', updated_at: '', version: 1, ...patch });

describe('knowledge tree and search', () => {
  it('sorts each level and keeps shared/project trees independent', () => {
    const tree = buildKnowledgeTree([page('B'), page('A'), page('child', { parent_id: 'A' }), page('first', { sort_order: -1 })]);
    expect(tree.map(p => p.id)).toEqual(['first', 'A', 'B']);
    expect(tree[1].children[0].id).toBe('child');
  });
  it('allows three levels; rejects deeper moves, cycles and different scopes', () => {
    const pages = [page('a'), page('b', { parent_id: 'a' }), page('c', { parent_id: 'b' })];
    expect(() => validateKnowledgeTree(pages)).not.toThrow();
    expect(() => validateKnowledgeTree([...pages, page('d', { parent_id: 'c' })])).toThrow('kb_depth');
    expect(() => validateKnowledgeTree([page('a', { parent_id: 'b' }), page('b', { parent_id: 'a' })])).toThrow('kb_cycle');
    expect(() => validateKnowledgeTree([page('a'), page('b', { parent_id: 'a', project_id: 'project-a' })])).toThrow('kb_invalid_parent');
  });
  it('shows descendants when an archived ancestor was filtered out', () => {
    expect(buildKnowledgeTree([page('child', { parent_id: 'hidden' })])[0].id).toBe('child');
  });
  it('extracts decoded text without HTML or script text and preserves word boundaries', () => {
    expect(knowledgeText('<p>A &amp; B</p><p>C</p><script>secret</script>')).toBe('A & B C');
    const pages = [page('one', { title: 'Release Guide' }), page('two', { body: '<b>RELEASE</b> checklist' })];
    expect(searchKnowledge(pages, 'release').length).toBe(2);
    expect(searchKnowledge(pages, '<b>')).toEqual([]);
  });
  it('centres long snippets around the match and handles empty/missing terms', () => {
    const snippet = knowledgeSnippet(`<p>${'a '.repeat(90)}FIND ME ${'z '.repeat(90)}</p>`, 'find me', 70);
    expect(snippet).toContain('FIND ME');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(knowledgeSnippet('<p>Short</p>', 'absent')).toBe('Short');
    expect(knowledgeSnippet('', '')).toBe('');
  });
});

describe('mock revisions', () => {
  it('keeps the latest 20 revisions by version, not by timestamp ties', () => {
    const versions = Array.from({ length: 25 }, (_, i) => ({ version: i + 1 }));
    expect(latestKnowledgeRevisions(versions).map(r => r.version)).toEqual(Array.from({ length: 20 }, (_, i) => 25 - i));
  });
  it('seeds shared and project pages; saving/restoring preserves prior content', () => {
    const db: Record<string, Record<string, unknown>[]> = { projects: [{ id: 'project-a' }] };
    seedKnowledgeMock(db);
    expect(db.kb_pages.some(p => p.project_id === 'project-a')).toBe(true);
    for (let i = 1; i <= 24; i++) db.kb_pages[0] = knowledgeMockUpdate(db, db.kb_pages[0], { body: `body ${i}` });
    expect(db.kb_revisions).toHaveLength(20);
    expect(db.kb_revisions[0].body).toBe('body 23');
    db.kb_pages[0] = knowledgeMockUpdate(db, db.kb_pages[0], { body: db.kb_revisions[0].body });
    expect(db.kb_revisions[0].body).toBe('body 24');
  });
});
