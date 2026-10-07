import { describe, expect, it } from 'vitest';
import { emptySidebarOrder, moveSidebarItem, normalizeSidebarOrder, parseSidebarOrder, sidebarSortMode, sortSidebarItems } from '@/lib/sidebarOrder';

const ids = (items: { id: string }[]) => items.map(item => item.id);

describe('personal sidebar display order', () => {
  it('uses natural name order for the default and resolves equal names with stable IDs', () => {
    const items = [
      { id: 'z', name: 'Project 10' }, { id: 'second', name: 'Project 2' },
      { id: 'b', name: 'Alpha' }, { id: 'a', name: 'alpha' },
    ];
    expect(ids(sortSidebarItems(items, [], 'en'))).toEqual(['a', 'b', 'second', 'z']);
    expect(ids(sortSidebarItems([...items].reverse(), [], 'en'))).toEqual(['a', 'b', 'second', 'z']);
  });

  it('keeps custom items first and appends newly visible items by name without reviving stale IDs', () => {
    const items = [
      { id: 'new10', name: 'New 10' }, { id: 'saved', name: 'Zebra' },
      { id: 'new2', name: 'New 2' }, { id: 'first', name: 'Alpha' },
    ];
    expect(ids(sortSidebarItems(items, ['saved', 'revoked', 'first', 'saved'], 'en')))
      .toEqual(['saved', 'first', 'new2', 'new10']);
  });

  it('sorts only the authorized caller rows and leaves the inputs and records intact', () => {
    const items = Object.freeze([
      Object.freeze({ id: 'b', name: 'Beta', lineId: 'line-a' }),
      Object.freeze({ id: 'a', name: 'Alpha', lineId: 'line-a' }),
    ]);
    const order = Object.freeze(['not-visible', 'b']);
    const sorted = sortSidebarItems(items, order, 'en');
    expect(ids(sorted)).toEqual(['b', 'a']);
    expect(sorted[0]).toBe(items[0]);
    expect(ids([...items])).toEqual(['b', 'a']);
    expect(order).toEqual(['not-visible', 'b']);
    expect(sorted.every(item => item.lineId === 'line-a')).toBe(true);
  });

  it('falls back to a valid locale without losing records', () => {
    expect(ids(sortSidebarItems([{ id: '10', name: 'Item 10' }, { id: '2', name: 'Item 2' }], [], 'invalid_locale')))
      .toEqual(['2', '10']);
  });

  it('moves one item while preserving every ID and the original array', () => {
    const original = Object.freeze(['a', 'b', 'c']);
    expect(moveSidebarItem(original, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveSidebarItem(original, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(original).toEqual(['a', 'b', 'c']);
  });

  it.each([[-1, 0], [0, -1], [3, 0], [0, 3], [0.5, 1], [0, Number.NaN], [Number.POSITIVE_INFINITY, 0]])
    ('does not lose an item for an invalid move from %s to %s', (from, to) => {
      expect(moveSidebarItem(['a', 'b', 'c'], from, to)).toEqual(['a', 'b', 'c']);
    });

  it('validates the versioned preference and de-duplicates IDs without mutating the saved value', () => {
    const value = { version: 1, lineOrder: ['l2', 'l2', 'l1'], projectOrder: ['p2', 'p1', 'p2'] };
    expect(parseSidebarOrder(value)).toEqual({ version: 1, lineOrder: ['l2', 'l1'], projectOrder: ['p2', 'p1'] });
    expect(value.lineOrder).toEqual(['l2', 'l2', 'l1']);
    expect(value.projectOrder).toEqual(['p2', 'p1', 'p2']);
  });

  it.each([
    null, [], { version: 2, lineOrder: [], projectOrder: [] },
    { version: 1, lineOrder: [''], projectOrder: [] },
    { version: 1, lineOrder: [], projectOrder: [1] },
    { version: 1, lineOrder: [], projectOrder: ['x'.repeat(501)] },
    { version: 1, lineOrder: Array(5001).fill('x'), projectOrder: [] },
  ])('falls back safely for malformed or unbounded preference data', value => {
    expect(parseSidebarOrder(value)).toBeNull();
    expect(normalizeSidebarOrder(value)).toEqual(emptySidebarOrder());
  });
});

describe('sidebar name directions and legacy preferences', () => {
  const rows = [
    { id: 'han', name: '📁 [中文專案]' }, { id: '10', name: '🚀 Project 10' },
    { id: '2', name: '[Project 2]' }, { id: 'alpha-b', name: 'Alpha' }, { id: 'alpha-a', name: 'alpha' },
  ];
  it('keeps English names first in both directions, ignoring emoji and bracket prefixes', () => {
    expect(ids(sortSidebarItems(rows, ['han'], 'en', 'name_asc'))).toEqual(['alpha-a', 'alpha-b', '2', '10', 'han']);
    expect(ids(sortSidebarItems(rows, ['han'], 'en', 'name_desc'))).toEqual(['10', '2', 'alpha-a', 'alpha-b', 'han']);
  });
  it('keeps old custom rows and empty name-order rows valid without migration', () => {
    expect(sidebarSortMode(parseSidebarOrder({ version: 1, lineOrder: ['legacy'], projectOrder: [] })!)).toBe('custom');
    expect(sidebarSortMode(emptySidebarOrder())).toBe('name_asc');
    const value = { version: 1, lineOrder: ['han'], projectOrder: ['saved'], sortMode: 'name_desc' as const };
    expect(parseSidebarOrder(value)).toEqual(value);
    expect(ids(sortSidebarItems(rows, value.lineOrder, 'en', 'custom'))[0]).toBe('han');
    expect(value.lineOrder).toEqual(['han']);
  });
  it.each(['unknown', null, 2])('rejects an invalid new mode %s without overwriting it', sortMode => {
    expect(parseSidebarOrder({ version: 1, lineOrder: [], projectOrder: [], sortMode })).toBeNull();
  });
});
