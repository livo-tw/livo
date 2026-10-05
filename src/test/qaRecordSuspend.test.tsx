import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn() }) }));
import QaRecordView from '@/components/qa/QaRecordView';

describe('a bug dialog under a task', () => {
  it('is hidden while a task covers it and comes back with what was typed', () => {
    const { rerender } = render(<QaRecordView title="Checkout fails" busy={false} onClose={vi.fn()}><input aria-label="note" defaultValue="" /></QaRecordView>);
    const note = screen.getByLabelText('note') as HTMLInputElement;
    note.value = 'half-written comment';
    rerender(<QaRecordView title="Checkout fails" busy={false} suspended onClose={vi.fn()}><input aria-label="note" defaultValue="" /></QaRecordView>);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toHaveClass('hidden');
    rerender(<QaRecordView title="Checkout fails" busy={false} onClose={vi.fn()}><input aria-label="note" defaultValue="" /></QaRecordView>);
    expect(screen.getByRole('dialog', { name: 'Checkout fails' })).toBeTruthy();
    expect((screen.getByLabelText('note') as HTMLInputElement).value).toBe('half-written comment');
  });
});
