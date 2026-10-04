import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import KnowledgeShareActions from '@/components/knowledge/KnowledgeShareActions';
import type { KnowledgePage } from '@/types/knowledge';
const state = vi.hoisted(() => ({ read: vi.fn(), copy: vi.fn(async () => true), print: vi.fn(async () => {}) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/clipboard', () => ({ copyText: state.copy }));
vi.mock('@/lib/knowledgeSharing', async () => ({ ...await vi.importActual<typeof import('@/lib/knowledgeSharing')>('@/lib/knowledgeSharing'), printKnowledgePage: state.print }));
vi.mock('@/integrations/supabase/knowledgeClient', () => ({ knowledgeClient: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: state.read }) }) }) } }));
const page = { id: 'example-page', title: 'Cached title', body: '<p>Cached body</p>', updated_at: '2026-10-01' } as KnowledgePage;
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('knowledge sharing authorization', () => {
  it('copies the freshly authorized saved content rather than stale UI content', async () => {
    state.read.mockResolvedValue({ data: { ...page, title: 'Current title', body: '<p>Current approved body</p>' }, error: null });
    render(<KnowledgeShareActions page={page} scope="Example" onUnavailable={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'kb.sharing.export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'kb.sharing.copyContent' }));
    await waitFor(() => expect(state.copy).toHaveBeenCalledWith('Current title\n\nCurrent approved body'));
  });
  it('does not copy or print a body after access is revoked', async () => {
    state.read.mockResolvedValue({ data: null, error: null }); const unavailable = vi.fn();
    render(<KnowledgeShareActions page={page} scope="Example" onUnavailable={unavailable} />);
    fireEvent.click(screen.getByRole('button', { name: 'kb.sharing.export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'kb.sharing.exportPdf' }));
    await waitFor(() => expect(unavailable).toHaveBeenCalled());
    expect(state.copy).not.toHaveBeenCalled(); expect(state.print).not.toHaveBeenCalled();
  });
});
