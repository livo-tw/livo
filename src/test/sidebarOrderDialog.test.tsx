import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SidebarOrderDialog from '@/components/project/SidebarOrderDialog';
import type { SidebarOrder } from '@/lib/sidebarOrder';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' },
  t: (key: string, options?: { name?: string }) => options?.name ? `${key}:${options.name}` : key }) }));
afterEach(cleanup);
const lines = [{ id: 'a', name: 'Alpha' }, { id: 'z', name: 'Zebra' }, { id: 'han', name: '[中文產線]' }];
const projects = [{ id: 'p2', name: 'Project 2', lineId: 'z' }, { id: 'p10', name: 'Project 10', lineId: 'z' },
  { id: 'pa', name: 'Example', lineId: 'a' }, { id: 'ph', name: '中文專案', lineId: 'han' }];
function show(order: Partial<SidebarOrder> = {}) {
  const onSave = vi.fn(async () => true), onOpenChange = vi.fn();
  render(<SidebarOrderDialog open onOpenChange={onOpenChange} lines={lines} projects={projects}
    lineOrder={order.lineOrder ?? []} projectOrder={order.projectOrder ?? []} sortMode={order.sortMode}
    loading={false} saving={false} error={null} onSave={onSave} />);
  return { onSave, onOpenChange };
}
const lineNames = () => within(screen.getByRole('region', { name: 'sidebar.orderLines' })).getAllByRole('listitem').map(item => item.textContent);

describe('personal sidebar order dialog modes', () => {
  it('previews descending names while preserving saved custom order and cancels without saving', () => {
    const { onSave, onOpenChange } = show({ lineOrder: ['a'], projectOrder: ['p2'] });
    fireEvent.change(screen.getByRole('combobox', { name: 'sidebar.orderMode' }), { target: { value: 'name_desc' } });
    expect(lineNames()).toEqual(['Zebra', 'Alpha', '[中文產線]']);
    fireEvent.change(screen.getByRole('combobox', { name: 'sidebar.orderMode' }), { target: { value: 'custom' } });
    expect(lineNames()).toEqual(['Alpha', 'Zebra', '[中文產線]']);
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onSave).not.toHaveBeenCalled();
  });
  it('changes to custom after a move and preserves every other displayed group and hidden ID', async () => {
    const { onSave } = show({ lineOrder: ['hidden-line', 'a'], projectOrder: ['hidden-project', 'p2'] });
    fireEvent.change(screen.getByRole('combobox', { name: 'sidebar.orderMode' }), { target: { value: 'name_desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.orderMoveDown:Project 10' }));
    expect(screen.getByRole('combobox', { name: 'sidebar.orderMode' })).toHaveValue('custom');
    expect(lineNames()).toEqual(['Zebra', 'Alpha', '[中文產線]']);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sortMode: 'custom',
      lineOrder: ['hidden-line', 'z', 'a', 'han'], projectOrder: ['hidden-project', 'p2', 'p10', 'pa', 'ph'] }));
  });
  it('saves descending mode without discarding the stored manual IDs', async () => {
    const { onSave } = show({ lineOrder: ['a'], projectOrder: ['p2'] });
    fireEvent.change(screen.getByRole('combobox', { name: 'sidebar.orderMode' }), { target: { value: 'name_desc' } });
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sortMode: 'name_desc', lineOrder: ['a'], projectOrder: ['p2'] }));
  });
  it('restores ascending English-first defaults and clears manual order only on explicit reset', async () => {
    const { onSave } = show({ sortMode: 'name_desc', lineOrder: ['han'], projectOrder: ['ph'] });
    fireEvent.click(screen.getByRole('button', { name: 'sidebar.orderReset' }));
    expect(lineNames()).toEqual(['Alpha', 'Zebra', '[中文產線]']);
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ sortMode: 'name_asc', lineOrder: [], projectOrder: [] }));
  });
});
