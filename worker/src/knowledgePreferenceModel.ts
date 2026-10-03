export type NavigationPage = { id: string; parent_id: string | null; project_id: string | null; sort_order: number; title: string };
export type NavigationItem = { favorite: boolean; pinned: boolean; collapsed?: boolean };
export type NavigationPreferences = { version: number; items: Record<string, NavigationItem>; orders: Record<string, string[]>; pins: string[] };
export type NavigationCommand = { p_action: 'read' | 'favorite' | 'pin' | 'collapse' | 'reorder' | 'reset'; p_page_id?: string; p_value?: boolean; p_before_id?: string | null; p_order_kind?: 'tree' | 'pins'; p_version?: number };
export const emptyNavigation = (): NavigationPreferences => ({ version: 0, items: {}, orders: {}, pins: [] });
export const navigationScope = (page: NavigationPage) => JSON.stringify([page.project_id, page.parent_id]);
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

/** Preferences hold IDs only. Never return a stale identifier, count or ancestor. */
export function visibleNavigation(raw: Partial<NavigationPreferences>, pages: NavigationPage[]): NavigationPreferences {
  const result = emptyNavigation(); result.version = Number.isSafeInteger(raw.version) ? raw.version! : 0;
  const allowed = new Map(pages.map(page => [page.id, page]));
  for (const page of pages) {
    const item = raw.items && own(raw.items, page.id) ? raw.items[page.id] : undefined;
    if (item) result.items[page.id] = { favorite: !!(item.favorite || item.pinned), pinned: !!item.pinned, ...(typeof item.collapsed === 'boolean' ? { collapsed: item.collapsed } : {}) };
  }
  for (const [scope, ids] of Object.entries(raw.orders || {})) {
    if (!Array.isArray(ids)) continue;
    const valid = [...new Set(ids)].filter(id => allowed.has(id) && navigationScope(allowed.get(id)!) === scope);
    if (valid.length) result.orders[scope] = valid;
  }
  result.pins = [...new Set([...(Array.isArray(raw.pins) ? raw.pins : []), ...Object.keys(result.items)])].filter(id => allowed.has(id) && result.items[id]?.pinned);
  return result;
}

export function orderedNavigation(pages: NavigationPage[], ids: string[] = []): NavigationPage[] {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...pages].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity) || a.sort_order - b.sort_order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
}

/** Apply one owner-scoped operation; caller persists with a compare-and-swap. */
export function applyNavigation(raw: NavigationPreferences, pages: NavigationPage[], command: NavigationCommand): NavigationPreferences {
  if (command.p_order_kind !== undefined && !['tree','pins'].includes(command.p_order_kind)) throw new Error('kb_invalid_request');
  const page = pages.find(p => p.id === command.p_page_id);
  if (!page || page.id === '__proto__' || page.id === 'constructor' || page.id === 'prototype') throw new Error('kb_forbidden');
  if (!['favorite', 'pin', 'collapse', 'reorder', 'reset'].includes(command.p_action)) throw new Error('kb_invalid_request');
  const next = structuredClone(raw);
  next.items ||= {}; next.orders ||= {}; next.pins ||= [];
  if (['favorite', 'pin', 'collapse'].includes(command.p_action)) {
    if (typeof command.p_value !== 'boolean') throw new Error('kb_invalid_request');
    const item: NavigationItem = own(next.items, page.id) ? { ...next.items[page.id] } : { favorite: false, pinned: false };
    if (command.p_action === 'favorite') { item.favorite = command.p_value; if (!item.favorite) item.pinned = false; }
    if (command.p_action === 'pin') { item.pinned = command.p_value; if (item.pinned) item.favorite = true; }
    if (command.p_action === 'collapse') item.collapsed = command.p_value;
    next.items[page.id] = item;
    next.pins = next.pins.filter(id => id !== page.id);
    if (item.pinned) {
      const oldPosition = raw.pins.indexOf(page.id);
      next.pins.splice(oldPosition < 0 ? next.pins.length : oldPosition, 0, page.id);
    }
  } else {
    const pins = command.p_order_kind === 'pins';
    const scope = navigationScope(page);
    const siblings = pins ? pages.filter(p => next.items[p.id]?.pinned) : pages.filter(p => navigationScope(p) === scope);
    if (!siblings.some(p => p.id === page.id)) throw new Error('kb_invalid_request');
    if (command.p_action === 'reset') { if (pins) next.pins = siblings.map(p => p.id); else delete next.orders[scope]; }
    else {
      const before = command.p_before_id;
      if (before !== null && (typeof before !== 'string' || before === page.id || !siblings.some(p => p.id === before))) throw new Error('kb_invalid_request');
      const stored = pins ? next.pins : next.orders[scope] || [];
      const visible = orderedNavigation(siblings, stored).map(p => p.id).filter(id => id !== page.id);
      visible.splice(before === null ? visible.length : visible.indexOf(before!), 0, page.id);
      // Preserve hidden identifiers internally, without returning them or their count.
      const hidden = stored.filter(id => !siblings.some(p => p.id === id));
      if (pins) next.pins = [...visible, ...hidden]; else next.orders[scope] = [...visible, ...hidden];
    }
  }
  next.version = raw.version + 1;
  return next;
}
