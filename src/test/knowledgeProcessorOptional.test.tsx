import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { User } from '@/types';
import KnowledgeImportDialog from '@/components/KnowledgeImportDialog';
import { knowledgeImportMessages } from '@/i18n/knowledgeImport';
import en from '@/i18n/locales/en.json';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';

vi.mock('@/lib/knowledgeImportClient', () => ({ knowledgeImportRequest: vi.fn(async () => []), fileBase64: vi.fn(), downloadImportPreview: vi.fn() }));
vi.mock('@/hooks/useKnowledgeImportCapability', () => ({ useKnowledgeImportCapability: () => ({ allowed: true, loading: false, can_manage: false, notion_available: false, processor_configured: false }) }));
vi.mock('@/context/ProjectContext', () => ({ useProjectContext: () => ({ allProjects: [] as never[], productLines: [] as never[] }) }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue || _key, i18n: { language: 'en' } }) }));

const user: User = { id: 'person', name: 'Example Person', role: 'member', jobTitle: 'PM', isActive: true, email: 'example@example.com', avatar: '', color: '', sortOrder: 0 };

describe('import dialog without the optional processor', () => {
  it('explains that Word needs the processor and does not start that upload', async () => {
    render(<KnowledgeImportDialog open onOpenChange={() => {}} pages={[]} users={[]} actor={user} onImported={() => {}} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Word .docx' }));
    expect((await screen.findByRole('alert')).textContent).toBe(knowledgeImportMessages.en.processorMissing);
    expect(screen.getByRole('button', { name: knowledgeImportMessages.en.start })).toBeDisabled();
  });

  it('has the unreachable-processor message in every language', () => {
    for (const [lang, file] of [['en', en], ['zh-TW', zhTW], ['zh-CN', zhCN]] as const)
      expect((file as { kbImport: Record<string, string> }).kbImport.processor_unavailable).toBe(knowledgeImportMessages[lang].processor_unavailable);
  });
});
