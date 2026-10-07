import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { ColoredStatusSelect } from '@/components/ui/colored-status-select';
const choices = [
  { value: 'new', label: '新回報', color: '#112233' },
  { value: 'in_progress', label: '修復中', color: '#223344' },
  { value: 'verification', label: '待驗證', color: '#334455' },
  { value: 'verified', label: 'PASS', color: '#445566' },
  { value: 'failed', label: 'FAIL', color: '#556677' },
  { value: 'dismissed', label: '不處理', color: '#667788' },
];
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
});
afterEach(() => { cleanup(); Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView'); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('a hidden current QA state remains display only', () => {
  it.each([6, 5])('keeps the Chinese current label and colour without making it an option (%i choices)', async count => {
    const changed = vi.fn();
    render(<ColoredStatusSelect label="變更狀態" value="triaged" options={choices.slice(0, count)} displayCurrentOption={{ value: 'triaged', label: '已分配', color: '#aabbcc' }} onValueChange={changed} />);
    const trigger = screen.getByRole('combobox', { name: '變更狀態' });
    await waitFor(() => expect(within(trigger).getByText('已分配')).toBeInTheDocument());
    expect(trigger.querySelector('[data-status-dot]')).toHaveStyle({ backgroundColor: '#aabbcc' });
    fireEvent.click(trigger);
    expect(screen.queryByRole('option', { name: '已分配' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '已結案' })).not.toBeInTheDocument();
    expect(document.querySelector('select option[value="triaged"]')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'PASS' }));
    expect(changed).toHaveBeenCalledTimes(1); expect(changed).toHaveBeenCalledWith('verified');
  });
  it('shows the historical completed label with no manual choices or selectable dummy option', () => {
    render(<ColoredStatusSelect label="變更狀態" value="closed" disabled options={[]} displayCurrentOption={{ value: 'closed', label: '完成', color: '#123456' }} onValueChange={vi.fn()} />);
    const trigger = screen.getByRole('combobox', { name: '變更狀態' });
    expect(trigger).toBeDisabled(); expect(within(trigger).getByText('完成')).toBeInTheDocument();
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });
  it('an unrelated display option cannot replace the actual current value', () => {
    render(<ColoredStatusSelect label="變更狀態" value="new" options={choices.slice(0, 5)} displayCurrentOption={{ value: 'closed', label: '完成' }} onValueChange={vi.fn()} />);
    expect(within(screen.getByRole('combobox', { name: '變更狀態' })).getByText('新回報')).toBeInTheDocument();
    expect(screen.queryByText('完成')).not.toBeInTheDocument();
  });
});
