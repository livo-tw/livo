import { describe, expect, it } from 'vitest';
import { knowledgeDirectoryPages } from '@/lib/knowledge';

const pages: Array<{ id: string; project_id: string | null; private_draft_owner_id?: string }> = [
  { id: 'project-page', project_id: 'p1' },
  { id: 'shared-page', project_id: null },
  { id: 'my-draft', project_id: null, private_draft_owner_id: 'me' },
  { id: 'other-draft', project_id: null, private_draft_owner_id: 'someone' },
];

describe('the knowledge directory under a sidebar scope', () => {
  it('keeps my own private drafts reachable and leaves other shared pages out', () => {
    expect(knowledgeDirectoryPages(pages, true, 'me').map(page => page.id)).toEqual(['project-page', 'my-draft']);
    expect(knowledgeDirectoryPages(pages, true, null).map(page => page.id)).toEqual(['project-page']);
    expect(knowledgeDirectoryPages(pages, false, 'me')).toBe(pages);
  });
});
