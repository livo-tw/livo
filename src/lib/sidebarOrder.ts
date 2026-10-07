export type SidebarSortMode = 'name_asc' | 'name_desc' | 'custom';

export interface SidebarOrder {
  version: 1;
  lineOrder: string[];
  projectOrder: string[];
  sortMode?: SidebarSortMode;
}

export const emptySidebarOrder = (): SidebarOrder => ({ version: 1, lineOrder: [], projectOrder: [] });
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 5000 && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500);
const unique = (ids: readonly string[]) => [...new Set(ids)];

/** Older v1 rows retain their custom order, while an empty row defaults to name order. */
export const sidebarSortMode = (order: SidebarOrder): SidebarSortMode => order.sortMode ?? (order.lineOrder.length || order.projectOrder.length ? 'custom' : 'name_asc');

/** Preferences contain IDs and a display mode only; visibility comes from the caller's rows. */
export function parseSidebarOrder(value: unknown): SidebarOrder | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !validIds(row.lineOrder) || !validIds(row.projectOrder)) return null;
  if (row.sortMode !== undefined && !['name_asc', 'name_desc', 'custom'].includes(row.sortMode as string)) return null;
  return { version: 1, lineOrder: unique(row.lineOrder), projectOrder: unique(row.projectOrder),
    ...(row.sortMode === undefined ? {} : { sortMode: row.sortMode as SidebarSortMode }) };
}

export function normalizeSidebarOrder(value: unknown): SidebarOrder {
  return parseSidebarOrder(value) ?? emptySidebarOrder();
}

/** Ignore leading punctuation/emoji when grouping names; English precedes Chinese in both directions. */
function nameGroup(name: string): number {
  const first = name.match(/[A-Za-z\p{Script=Han}]/u)?.[0];
  return first ? (/[A-Za-z]/.test(first) ? 0 : 1) : 2;
}
const sortableName = (name: string): string => name.replace(/^[^\p{L}\p{N}]+/u, '');

/** Custom items lead; new visible items follow by name. Name modes preserve saved IDs without applying them. */
export function sortSidebarItems<T extends { id: string; name: string }>(items: readonly T[], order: readonly string[] = [], locale = 'zh-TW', mode: SidebarSortMode = 'custom'): T[] {
  let collator: Intl.Collator;
  try { collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }); }
  catch { collator = new Intl.Collator('zh-TW', { numeric: true, sensitivity: 'base' }); }
  const ranks = new Map(unique(mode === 'custom' ? order : []).map((id, index) => [id, index]));
  const direction = mode === 'name_desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const ar = ranks.get(a.id), br = ranks.get(b.id);
    if (ar !== undefined || br !== undefined) return (ar ?? Infinity) - (br ?? Infinity);
    return nameGroup(a.name) - nameGroup(b.name)
      || direction * collator.compare(sortableName(a.name), sortableName(b.name))
      || a.id.localeCompare(b.id, 'en');
  });
}

export function moveSidebarItem(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}
