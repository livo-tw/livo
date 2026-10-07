export interface SidebarOrder {
  version: 1;
  lineOrder: string[];
  projectOrder: string[];
}

export const emptySidebarOrder = (): SidebarOrder => ({ version: 1, lineOrder: [], projectOrder: [] });
const validIds = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 5000 && value.every(id => typeof id === 'string' && id.length > 0 && id.length <= 500);
const unique = (ids: readonly string[]) => [...new Set(ids)];

/** Preferences contain IDs only; visibility always comes from the caller's rows. */
export function parseSidebarOrder(value: unknown): SidebarOrder | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || !validIds(row.lineOrder) || !validIds(row.projectOrder)) return null;
  return { version: 1, lineOrder: unique(row.lineOrder), projectOrder: unique(row.projectOrder) };
}

export function normalizeSidebarOrder(value: unknown): SidebarOrder {
  return parseSidebarOrder(value) ?? emptySidebarOrder();
}

/** Saved items lead, while newly visible items follow in natural name order. */
export function sortSidebarItems<T extends { id: string; name: string }>(items: readonly T[], order: readonly string[] = [], locale = 'zh-TW'): T[] {
  let collator: Intl.Collator;
  try { collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' }); }
  catch { collator = new Intl.Collator('zh-TW', { numeric: true, sensitivity: 'base' }); }
  const ranks = new Map(unique(order).map((id, index) => [id, index]));
  return [...items].sort((a, b) => {
    const ar = ranks.get(a.id), br = ranks.get(b.id);
    if (ar !== undefined || br !== undefined) return (ar ?? Infinity) - (br ?? Infinity);
    return collator.compare(a.name, b.name) || a.id.localeCompare(b.id, 'en');
  });
}

export function moveSidebarItem(ids: readonly string[], from: number, to: number): string[] {
  const next = [...ids];
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}