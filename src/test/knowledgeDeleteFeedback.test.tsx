import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import KnowledgeBaseView from '@/components/KnowledgeBaseView';
import { supabase } from '@/integrations/supabase/client';
import { knowledgeClient } from '@/integrations/supabase/knowledgeClient';
import { knowledgeDeleteErrorKey, knowledgeInsidePrivateDraft } from '@/lib/knowledge';
import en from '@/i18n/locales/en.json';

vi.mock('@/integrations/supabase/client', async () => {
  const { createMockClient } = await import('@/integrations/supabase/mockClient');
  return { supabase: createMockClient(), USING_MOCK_BACKEND: true };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: 'm-001', currentMember: { role: 'super_admin' } }) }));
vi.mock('@/context/ProjectContext', async () => ({ ...(await vi.importActual<typeof import('@/context/ProjectContext')>('@/context/ProjectContext')), useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[], selectedProjectId: null as string | null }) }));
vi.mock('@/context/MemberContext', async () => ({ ...(await vi.importActual<typeof import('@/context/MemberContext')>('@/context/MemberContext')), useMemberContext: () => ({ users: [{ id: 'm-001', name: 'Example Member', role: 'super_admin' }] }) }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ acquireLock: vi.fn(async () => ({ acquired: true })), releaseLock: vi.fn(), isLockedBy: (): null => null }) }));
vi.mock('@/components/RichTextEditorLazy', () => ({ default: ({ content }: { content: string }) => <textarea aria-label="Body" value={content} readOnly /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
  let value: unknown = en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  return String(value || opts?.defaultValue || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] || ''));
} }) }));

const RECEIPT_FK = 'update or delete on table "kb_pages" violates foreign key constraint "kb_work_receipts_page_id_fkey" on table "kb_work_receipts"';
const PARENT_FK = 'update or delete on table "kb_pages" violates foreign key constraint "kb_pages_parent_id_fkey" on table "kb_pages"';

beforeEach(async () => {
  (supabase.constructor as unknown as { resetMockData: () => void }).resetMockData();
  await supabase.auth.signInWithPassword({ email: 'admin@livo.test', password: 'test1234' });
  window.history.replaceState({}, '', window.location.pathname);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Demo must not access a backend'); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('refused knowledge page deletion is explained', () => {
  it.each([
    [PARENT_FK, 'kb_has_children'],
    [RECEIPT_FK, 'kb_delete_blocked'],
    ['D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT', 'kb_delete_blocked'],
    ['knowledge_conflict', 'kb_delete_blocked'],
    ['kb_conflict', 'kb_conflict'],
    ['kb_forbidden', 'kb_forbidden'],
    ['network down', 'kb_failed'],
  ])('maps %s', (message, key) => expect(knowledgeDeleteErrorKey({ message })).toBe(key));

  it('detects pages inside a private draft through any ancestor', () => {
    const pages: { id: string; parent_id: string | null; private_draft_owner_id: string | null }[] = [{ id: 'draft', parent_id: null, private_draft_owner_id: 'm-1' }, { id: 'inside', parent_id: 'draft', private_draft_owner_id: null },
      { id: 'shared', parent_id: null, private_draft_owner_id: null }, { id: 'loop', parent_id: 'loop', private_draft_owner_id: null }];
    expect(['draft', 'inside', 'shared', 'loop', 'missing', null].map(id => knowledgeInsidePrivateDraft(pages, id))).toEqual([true, true, false, false, false, false]);
  });

  it('shows a clear message when the server still refuses to delete a page', async () => {
    const error = vi.spyOn(toast, 'error');
    const from = supabase.from.bind(supabase);
    vi.spyOn(supabase, 'from').mockImplementation(((table: string): unknown => {
      const builder = from(table as never);
      if (table !== 'kb_pages') return builder;
      return new Proxy(builder, { get(target, prop) {
        if (prop === 'delete') return () => ({ eq: () => ({ select: () => ({ single: async () => ({ data: null as unknown, error: { message: RECEIPT_FK } }) }) }) });
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    }) as never);
    window.history.replaceState({}, '', `${window.location.pathname}?kb=kb-demo-howto`);
    render(<KnowledgeBaseView />);
    await screen.findByRole('heading', { name: 'How to share a decision' });
    // Delete sits in the page's "More actions" menu.
    fireEvent.click(screen.getByRole('button', { name: en.kb.moreActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: en.kb.delete }));
    await waitFor(() => expect(error).toHaveBeenCalledWith(en.kb.errors.kb_delete_blocked));
    expect(screen.getByRole('heading', { name: 'How to share a decision' })).toBeInTheDocument();
  });

  it('lets the owner delete an own draft that knowledge work saved', async () => {
    const error = vi.spyOn(toast, 'error');
    const input = { kind: 'meeting', title: 'Example private draft', notes: 'Example notes', sourceRefs: [] as unknown[] };
    const preview = (await supabase.functions.invoke('knowledge-work', { body: { type: 'query', query: { operation: 'prepare_draft', input } } })).data;
    const saved = (await supabase.functions.invoke('knowledge-work', { body: { type: 'command', command: { commandId: 'ui-delete-draft-command', operation: 'save_draft', preview, title: input.title, text: input.notes, confirmed: true } } })).data;
    window.history.replaceState({}, '', `${window.location.pathname}?kb=${saved.page.pageId}`);
    render(<KnowledgeBaseView />);
    await screen.findByRole('heading', { name: 'Example private draft' });
    // Delete sits in the page's "More actions" menu.
    fireEvent.click(screen.getByRole('button', { name: en.kb.moreActions }));
    fireEvent.click(await screen.findByRole('menuitem', { name: en.kb.delete }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Example private draft' })).not.toBeInTheDocument());
    expect((await knowledgeClient.from('kb_pages').select('id').eq('id', saved.page.pageId)).data).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});
