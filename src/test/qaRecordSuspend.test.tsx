import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const viewport = vi.hoisted(() => ({ mobile: false }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => viewport.mobile }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/context/UIContext', () => ({ useUIContext: () => ({ taskDisplayMode: 'modal', setTaskDisplayMode: vi.fn() }) }));
import QaRecordView from '@/components/qa/QaRecordView';

afterEach(() => { cleanup(); vi.restoreAllMocks(); viewport.mobile = false; document.documentElement.style.removeProperty('--livo-viewport-height'); document.documentElement.style.removeProperty('--livo-viewport-top'); });

describe('a bug dialog under a task', () => {
  it('keeps a mobile report inside the visual viewport when the keyboard changes its height and offset', () => {
    viewport.mobile = true;
    // JSDOM cannot evaluate calc(var(...)); capture what React supplies to the
    // browser while the existing form stays mounted through a keyboard resize.
    const height = vi.spyOn(CSSStyleDeclaration.prototype, 'height', 'set');
    const top = vi.spyOn(CSSStyleDeclaration.prototype, 'top', 'set');
    const bottom = vi.spyOn(CSSStyleDeclaration.prototype, 'bottom', 'set');
    const onClose = vi.fn();
    const { rerender } = render(<QaRecordView title="New report" creating busy={false} onClose={onClose}><input aria-label="Report title" defaultValue="Example report" /><button type="button">Save report</button></QaRecordView>);
    const record = screen.getByRole('dialog', { name: 'New report' });
    const title = screen.getByRole('textbox', { name: 'Report title' });
    document.documentElement.style.setProperty('--livo-viewport-height', '280px');
    document.documentElement.style.setProperty('--livo-viewport-top', '120px');
    rerender(<QaRecordView title="New report" creating busy={false} onClose={onClose}><input aria-label="Report title" defaultValue="Example report" /><button type="button">Save report</button></QaRecordView>);
    expect(height).toHaveBeenCalledWith(expect.stringContaining('var(--livo-viewport-height, 100dvh)'));
    expect(top).toHaveBeenCalledWith(expect.stringContaining('var(--livo-viewport-top, 0px)'));
    expect(bottom).toHaveBeenCalledWith('auto');
    expect(screen.getByRole('dialog', { name: 'New report' })).toBe(record);
    expect(screen.getByRole('textbox', { name: 'Report title' })).toBe(title);
    expect(title).toHaveValue('Example report');
    expect(screen.getByRole('button', { name: 'Save report' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
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
