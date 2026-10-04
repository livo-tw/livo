import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import KnowledgeBaseView from '@/components/KnowledgeBaseView';
import { supabase } from '@/integrations/supabase/client';
import en from '@/i18n/locales/en.json';

const state = vi.hoisted(() => ({ memberId: null as string | null }));
vi.mock('@/integrations/supabase/client', async () => {
  const { createMockClient } = await import('@/integrations/supabase/mockClient');
  return { supabase: createMockClient(), USING_MOCK_BACKEND: true };
});
vi.mock('@/context/AuthContext', () => ({ useAuthContext: () => ({ currentMemberId: state.memberId, currentMember: state.memberId ? { id: state.memberId, role: 'super_admin', jobTitle: 'PM' } : null }) }));
vi.mock('@/context/MemberContext', async () => ({ ...(await vi.importActual<typeof import('@/context/MemberContext')>('@/context/MemberContext')), useMemberContext: () => ({ users: [] as never[] }) }));
vi.mock('@/context/ProjectContext', async () => ({ ...(await vi.importActual<typeof import('@/context/ProjectContext')>('@/context/ProjectContext')), useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[], selectedProjectId: null as string | null }) }));
vi.mock('@/hooks/usePresenceLock', () => ({ usePresenceLock: () => ({ acquireLock: vi.fn(async () => ({ acquired: true })), releaseLock: vi.fn(), isLockedBy: (): null => null }) }));
vi.mock('@/components/RichTextEditorLazy', () => ({ default: ({ content }: { content: string }) => <textarea aria-label="Body" value={content} readOnly /> }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, opts?: Record<string, unknown>) => {
  let value: unknown = en;
  for (const part of key.split('.')) value = (value as Record<string, unknown>)?.[part];
  return String(value || key).replace(/\{\{(\w+)\}\}/g, (_, name) => String(opts?.[name] || ''));
} }) }));

beforeEach(async () => {
  (supabase.constructor as unknown as { resetMockData: () => void }).resetMockData();
  await supabase.auth.signInWithPassword({ email: 'admin@livo.test', password: 'test1234' });
  state.memberId = null;
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Demo must not access a backend'); }));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/'); });

describe('knowledge deep link after an identity change', () => {
  it('keeps ?knowledge= until pages for the signed-in member have loaded, then opens the page', async () => {
    window.history.replaceState({}, '', '/?knowledge=kb-demo-howto');
    const view = render(<KnowledgeBaseView />);
    // Pages finish loading before the member identity is known.
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(window.location.search).toContain('knowledge=kb-demo-howto');
    state.memberId = 'm-001';
    view.rerender(<KnowledgeBaseView />);
    expect(window.location.search).toContain('knowledge=kb-demo-howto');
    await screen.findByRole('heading', { name: 'How to share a decision' });
    await waitFor(() => expect(window.location.search).not.toContain('knowledge='));
  });
  it('keeps a ?kb= selection through the same identity change', async () => {
    window.history.replaceState({}, '', '/?kb=kb-demo-howto');
    const view = render(<KnowledgeBaseView />);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
    state.memberId = 'm-001';
    view.rerender(<KnowledgeBaseView />);
    await screen.findByRole('heading', { name: 'How to share a decision' });
  });
  it('still removes a link to a page the member cannot open once that member has loaded', async () => {
    state.memberId = 'm-001';
    window.history.replaceState({}, '', '/?knowledge=kb-does-not-exist');
    render(<KnowledgeBaseView />);
    await waitFor(() => expect(window.location.search).not.toContain('knowledge='));
    expect(screen.queryByRole('heading', { name: 'How to share a decision' })).toBeNull();
  });
});
