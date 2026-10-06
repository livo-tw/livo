import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type CollisionDetection, type KeyboardCoordinateGetter, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChevronDown, ChevronRight, FileText, FolderOpen, GripVertical, Pin, Star, MoreHorizontal, ArrowUp, ArrowDown, Check, ListTree } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { IconAction } from '@/components/ui/icon-action';
import { buildKnowledgeTree, searchKnowledge, knowledgeSnippet, type KnowledgeNode } from '@/lib/knowledge';
import { navigationScope, orderedNavigation } from '../../../worker/src/knowledgePreferenceModel';
import type { KnowledgePage } from '@/types/knowledge';
import type { useKnowledgeNavigation } from '@/hooks/useKnowledgeNavigation';

type Navigation = ReturnType<typeof useKnowledgeNavigation>;
type Props = { pages: KnowledgePage[]; groups: { id: string; name: string }[]; query: string; filtered: boolean; selectedId: string | null; onSelect: (id: string) => void; navigation: Navigation; busy?: boolean; scopeName: (id: string | null) => string };
const key = (name: string) => `kb.navigation.${name}`;

export function KnowledgePageActions({ page, navigation, busy, compact = false }: { page: KnowledgePage; navigation: Navigation; busy?: boolean; compact?: boolean }) {
  const { t } = useTranslation();
  const item = navigation.preferences.items[page.id];
  const disabled = busy || navigation.saving;
  const favoriteLabel = t(key(item?.favorite ? 'unfavorite' : 'favorite'), { title: page.title, defaultValue: `${item?.favorite ? 'Remove favorite' : 'Favorite'}: ${page.title}` });
  const pinLabel = t(key(item?.pinned ? 'unpin' : 'pin'), { title: page.title, defaultValue: `${item?.pinned ? 'Unpin' : 'Pin for me'}: ${page.title}` });
  const favorite = () => {
    if (item?.pinned && !window.confirm(t(key('removePinnedFavorite'), { defaultValue: 'Remove this favorite and its personal pin?' }))) return;
    void navigation.mutate({ p_action: 'favorite', p_page_id: page.id, p_value: !item?.favorite });
  };
  const pin = () => { void navigation.mutate({ p_action: 'pin', p_page_id: page.id, p_value: !item?.pinned }); };
  if (compact) return <DropdownMenu>
    <DropdownMenuTrigger asChild><button type="button" disabled={disabled} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t(key('pageActions'), { title: page.title, defaultValue: `Page actions: ${page.title}` })}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
    <DropdownMenuContent align="end">
      <DropdownMenuItem disabled={disabled} aria-label={favoriteLabel} onSelect={favorite}><Star size={15} className={item?.favorite ? 'fill-amber-400 text-amber-600' : ''} />{t(key(item?.favorite ? 'unfavoriteAction' : 'favoriteAction'))}</DropdownMenuItem>
      <DropdownMenuItem disabled={disabled} aria-label={pinLabel} onSelect={pin}><Pin size={15} className={item?.pinned ? 'text-primary' : ''} />{t(key(item?.pinned ? 'unpinAction' : 'pinAction'))}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
  return <>
    <IconAction disabled={disabled} pressed={!!item?.favorite} ariaLabel={favoriteLabel} label={t(key(item?.favorite ? 'unfavoriteAction' : 'favoriteAction'))} onClick={favorite}><Star size={16} className={item?.favorite ? 'fill-amber-400 text-amber-600' : ''} /></IconAction>
    <IconAction disabled={disabled} pressed={!!item?.pinned} ariaLabel={pinLabel} label={t(key(item?.pinned ? 'unpinAction' : 'pinAction'))} onClick={pin}><Pin size={16} className={item?.pinned ? 'fill-primary/20' : ''} /></IconAction>
  </>;
}

type RowProps = { node: KnowledgeNode; depth: number; selectedId: string | null; collapsed: boolean; reorder: boolean; disabled: boolean; onSelect: (id: string) => void; onToggle: () => void; onMove: (direction: -1 | 1) => void; onReset: () => void; first: boolean; last: boolean; navigation: Navigation; scopeLabel?: string; snippet?: string; children?: React.ReactNode };
function NavigationRow({ node, depth, selectedId, collapsed, reorder, disabled, onSelect, onToggle, onMove, onReset, first, last, navigation, scopeLabel, snippet, children }: RowProps) {
  const { t } = useTranslation();
  const sortable = useSortable({ id: node.id, disabled: !reorder || disabled });
  const item = navigation.preferences.items[node.id];
  return <li>
    <div ref={sortable.setNodeRef} data-kb-row={node.id} style={{ transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition, '--kb-indent': `${depth * 16}px` } as React.CSSProperties} className={`group my-0.5 flex min-w-0 items-start gap-1 rounded-lg px-1 [margin-left:min(var(--kb-indent),48px)] md:[margin-left:var(--kb-indent)] ${node.id === selectedId ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/15' : 'hover:bg-accent/70'} ${sortable.isDragging ? 'relative z-20 bg-card shadow-md' : ''}`}>
      {reorder && <button type="button" ref={sortable.setActivatorNodeRef} {...sortable.attributes} {...sortable.listeners} disabled={disabled} aria-label={t(key('drag'), { title: node.title, defaultValue: `Move in my order: ${node.title}` })} className="mt-1 flex h-8 w-7 shrink-0 touch-none items-center justify-center rounded text-muted-foreground [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"><GripVertical size={14} /></button>}
      {node.children.length ? <button type="button" disabled={disabled} onClick={onToggle} aria-expanded={!collapsed} aria-label={t(key(collapsed ? 'expand' : 'collapse'), { title: node.title, defaultValue: `${collapsed ? 'Expand' : 'Collapse'}: ${node.title}` })} className="mt-1 flex h-8 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11">{collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}</button> : <span className="mt-2.5 flex w-7 shrink-0 items-center justify-center text-muted-foreground"><FileText size={15} aria-hidden="true" /></span>}
      <button type="button" data-kb-page={node.id} disabled={disabled} onClick={() => onSelect(node.id)} onKeyDown={event => {
        if (event.key === 'ArrowRight' && node.children.length && collapsed) { event.preventDefault(); onToggle(); }
        else if (event.key === 'ArrowLeft' && node.children.length && !collapsed) { event.preventDefault(); onToggle(); }
        else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
          event.preventDefault(); const buttons = Array.from(event.currentTarget.closest('nav')?.querySelectorAll<HTMLButtonElement>('button[data-kb-page]') || []);
          const index = buttons.indexOf(event.currentTarget); buttons[index + (event.key === 'ArrowUp' ? -1 : 1)]?.focus();
        }
      }} aria-label={node.title} aria-current={node.id === selectedId ? 'page' : undefined} className="min-h-11 min-w-0 flex-1 py-2.5 text-left text-sm leading-5">
        <span className="block break-words [overflow-wrap:anywhere]">{node.title}</span>
        {(scopeLabel || node.is_archived) && <span className="mt-1 block text-xs text-muted-foreground">{scopeLabel}{scopeLabel && node.is_archived ? ' · ' : ''}{node.is_archived ? t('kb.archived') : ''}</span>}
        {snippet && <span className="mt-1 block break-words text-xs leading-5 text-muted-foreground">{snippet}</span>}
      </button>
      {!reorder && <div className="mt-1 flex shrink-0 items-center gap-0.5">{item?.pinned ? <Pin size={12} className="text-primary" aria-label={t(key('pins'), { defaultValue: 'My pins' })} /> : item?.favorite ? <Star size={12} className="fill-amber-400 text-amber-600" aria-label={t(key('favorites'), { defaultValue: 'My favorites' })} /> : null}<KnowledgePageActions page={node} navigation={navigation} busy={disabled} compact /></div>}
      {reorder && <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t(key('moveMenu'), { title: node.title, defaultValue: `Move options: ${node.title}` })}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem disabled={disabled || first} onSelect={() => onMove(-1)}><ArrowUp size={14} />{t(key('moveUp'), { defaultValue: 'Move up' })}</DropdownMenuItem>
          <DropdownMenuItem disabled={disabled || last} onSelect={() => onMove(1)}><ArrowDown size={14} />{t(key('moveDown'), { defaultValue: 'Move down' })}</DropdownMenuItem>
          <DropdownMenuItem disabled={disabled} onSelect={onReset}>{t(key('resetOrder'), { defaultValue: 'Restore team order' })}</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
    {!collapsed && children}
  </li>;
}

export default function KnowledgeNavigation({ pages, groups, query, filtered, selectedId, onSelect, navigation, busy = false, scopeName }: Props) {
  const { t } = useTranslation();
  const [view, setView] = useState<'tree' | 'favorites' | 'pins'>('tree');
  const [editingOrder, setEditingOrder] = useState(false);
  const [temporary, setTemporary] = useState<Record<string, boolean>>({});
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [closedGroups, setClosedGroups] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState('');
  const { preferences } = navigation;
  const allowedDropIds = (activeId: string) => {
    const activePage = pages.find(page => page.id === activeId);
    if (!activePage) return new Set<string>();
    return new Set(pages.filter(page => view === 'pins' ? preferences.items[page.id]?.pinned : navigationScope(page) === navigationScope(activePage)).map(page => page.id));
  };
  const siblingCollisions: CollisionDetection = args => {
    const allowed = allowedDropIds(String(args.active.id));
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(item => allowed.has(String(item.id))) });
  };
  const siblingKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
    const allowed = allowedDropIds(String(args.active));
    return sortableKeyboardCoordinates(event, { ...args, context: { ...args.context, droppableRects: new Map([...args.context.droppableRects].filter(([id]) => allowed.has(String(id)))) } });
  };
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(KeyboardSensor, { coordinateGetter: siblingKeyboardCoordinates }));
  useEffect(() => { setTemporary({}); setEditingOrder(false); }, [query, filtered]);
  const reorder = editingOrder && !filtered && !query.trim() && view !== 'favorites';
  const disabled = busy || navigation.saving;
  const scoped = useMemo(() => { const ids = new Set(groups.map(group => group.id)); return pages.filter(page => ids.has(page.project_id || 'shared')); }, [groups, pages]);
  const favorites = scoped.filter(page => preferences.items[page.id]?.favorite);
  const pinPages = orderedNavigation(scoped.filter(page => preferences.items[page.id]?.pinned), preferences.pins) as KnowledgePage[];
  const results = useMemo(() => searchKnowledge(pages, query), [pages, query]).filter(page => view === 'tree' || preferences.items[page.id]?.[view === 'pins' ? 'pinned' : 'favorite']);
  const selectedAncestors = new Set<string>();
  let cursor = pages.find(page => page.id === selectedId);
  while (cursor?.parent_id && !selectedAncestors.has(cursor.parent_id)) { selectedAncestors.add(cursor.parent_id); cursor = pages.find(page => page.id === cursor!.parent_id); }
  const revealKey = JSON.stringify([selectedId, ...selectedAncestors]);
  useEffect(() => { setRevealed(new Set(selectedAncestors)); }, [revealKey]);
  const selectedScope = pages.find(page => page.id === selectedId)?.project_id || 'shared';
  useEffect(() => { setClosedGroups(previous => { if (!previous.has(selectedScope)) return previous; const next = new Set(previous); next.delete(selectedScope); return next; }); }, [selectedId, selectedScope]);
  const collapsed = (node: KnowledgeNode) => temporary[node.id] ?? (filtered || revealed.has(node.id) ? false : preferences.items[node.id]?.collapsed ?? true);
  const toggle = (node: KnowledgeNode) => {
    if (filtered || query.trim()) setTemporary(old => ({ ...old, [node.id]: !collapsed(node) }));
    else void navigation.mutate({ p_action: 'collapse', p_page_id: node.id, p_value: !collapsed(node) }).then(ok => {
      if (!ok) return;
      setRevealed(old => { const next = new Set(old); next.delete(node.id); return next; });
      setTemporary(old => { if (!(node.id in old)) return old; const next = { ...old }; delete next[node.id]; return next; });
    });
  };
  async function move(page: KnowledgePage, before: string | null, kind: 'tree' | 'pins') {
    const ok = await navigation.mutate({ p_action: 'reorder', p_page_id: page.id, p_before_id: before, p_order_kind: kind });
    setMessage(t(key(ok ? 'orderSaved' : 'orderFailed'), { defaultValue: ok ? 'My order saved.' : 'Order was not saved. Please retry.' }));
  }
  const siblingsFor = (page: KnowledgePage) => view === 'pins' ? pinPages : orderedNavigation(pages.filter(candidate => navigationScope(candidate) === navigationScope(page)), preferences.orders[navigationScope(page)]) as KnowledgePage[];
  const moveRelative = (page: KnowledgePage, direction: -1 | 1) => {
    const list = siblingsFor(page), index = list.findIndex(candidate => candidate.id === page.id), to = index + direction;
    if (to < 0 || to >= list.length) return;
    const next = arrayMove(list, index, to); void move(page, next[to + 1]?.id || null, view === 'pins' ? 'pins' : 'tree');
  };
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!reorder || !over || active.id === over.id) return;
    const page = pages.find(candidate => candidate.id === active.id), target = pages.find(candidate => candidate.id === over.id);
    if (!page || !target || (view !== 'pins' && navigationScope(page) !== navigationScope(target))) { setMessage(t(key('sameParent'), { defaultValue: 'Move pages only within the same parent.' })); return; }
    const list = siblingsFor(page), from = list.findIndex(candidate => candidate.id === page.id), to = list.findIndex(candidate => candidate.id === target.id);
    if (from < 0 || to < 0) return;
    const next = arrayMove(list, from, to); void move(page, next[to + 1]?.id || null, view === 'pins' ? 'pins' : 'tree');
  };
  const rowProps = (page: KnowledgeNode, index: number, list: KnowledgeNode[]) => ({ node: page, depth: 0, selectedId, collapsed: true, reorder, disabled, onSelect, onToggle: () => {}, onMove: (direction: -1 | 1) => moveRelative(page, direction), onReset: () => { void navigation.mutate({ p_action: 'reset', p_page_id: page.id, p_order_kind: 'pins' }); }, first: index === 0, last: index === list.length - 1, navigation });
  const renderNodes = (nodes: KnowledgeNode[], depth = 0): React.ReactNode => {
    const list = orderedNavigation(nodes, preferences.orders[nodes[0] ? navigationScope(nodes[0]) : '']) as KnowledgeNode[];
    return <SortableContext items={list.map(page => page.id)} strategy={verticalListSortingStrategy}><ul>{list.map((node, index) => <NavigationRow key={node.id} {...rowProps(node, index, list)} depth={depth} collapsed={collapsed(node)} onToggle={() => toggle(node)} onReset={() => { void navigation.mutate({ p_action: 'reset', p_page_id: node.id, p_order_kind: 'tree' }); }}>{node.children.length > 0 && renderNodes(node.children, depth + 1)}</NavigationRow>)}</ul></SortableContext>;
  };
  const flat = (list: KnowledgePage[], sortable = false) => {
    const nodes: KnowledgeNode[] = list.map(page => ({ ...page, children: [] as KnowledgeNode[] }));
    const content = <ul>{nodes.map((node, index) => <NavigationRow key={node.id} {...rowProps(node, index, nodes)} reorder={sortable && reorder} scopeLabel={scopeName(node.project_id)} snippet={query.trim() ? knowledgeSnippet(node.body, query) : undefined} />)}</ul>;
    return sortable && reorder ? <SortableContext items={nodes.map(page => page.id)} strategy={verticalListSortingStrategy}>{content}</SortableContext> : content;
  };
  async function toggleAll(value: boolean) {
    const parents = scoped.filter(page => pages.some(child => child.parent_id === page.id));
    // The tree changes at once; saving follows in the background.
    setTemporary(Object.fromEntries(parents.map(page => [page.id, value])));
    if (filtered || query.trim()) return;
    if (!value) setRevealed(new Set());
    // Each save needs the version the previous one returned, so they run one after another,
    // and only for pages whose saved state differs.
    let saved = true;
    for (const page of parents.filter(candidate => (preferences.items[candidate.id]?.collapsed ?? true) !== value)) {
      if (!await navigation.mutate({ p_action: 'collapse', p_page_id: page.id, p_value: value })) { saved = false; break; }
    }
    if (saved) setTemporary({});
  }
  const visibleGroups = groups.filter(group => scoped.some(page => (page.project_id || 'shared') === group.id));
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 border-b px-3 pb-3">
      <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted/70 p-1" role="group" aria-label={t(key('views'), { defaultValue: 'Personal navigation' })}>
        {([{ id: 'tree', icon: ListTree, count: scoped.length }, { id: 'favorites', icon: Star, count: favorites.length }, { id: 'pins', icon: Pin, count: pinPages.length }] as const).map(option => <button type="button" key={option.id} aria-pressed={view === option.id} aria-label={t(key(option.id), { defaultValue: { tree: 'All pages', favorites: 'My favorites', pins: 'My pins' }[option.id] })} className={`flex min-h-10 min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-md px-1 text-xs font-medium transition-colors ${view === option.id ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => { setView(option.id); setEditingOrder(false); }}><option.icon size={14} className="shrink-0" aria-hidden="true" /><span className="truncate">{t(`kb.navigation.tabs.${option.id}`)}</span><span className="shrink-0 tabular-nums text-[11px] opacity-70" aria-hidden="true">{option.count}</span></button>)}
      </div>
    </div>
    <div className="flex shrink-0 items-center justify-between gap-2 px-4 py-3">
      <h2 className="text-xs font-medium text-muted-foreground">{query.trim() ? t(key('searchResults'), { count: results.length, defaultValue: `Search results (${results.length})` }) : t(key(view === 'tree' ? 'directory' : view), { defaultValue: view === 'tree' ? 'Page directory' : view === 'pins' ? 'My pins' : 'My favorites' })}</h2>
      {reorder ? <Button size="sm" variant="outline" className="h-8 gap-1 text-xs" onClick={() => setEditingOrder(false)}><Check size={13} />{t(key('finishOrder'), { defaultValue: 'Done ordering' })}</Button> : <DropdownMenu>
        <DropdownMenuTrigger asChild><button type="button" className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11" aria-label={t(key('directoryActions'), { defaultValue: 'Directory actions' })}><MoreHorizontal size={16} /></button></DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {view === 'tree' && <><DropdownMenuItem disabled={disabled} onSelect={() => { void toggleAll(false); }}>{t(key('expandAll'), { defaultValue: 'Expand all' })}</DropdownMenuItem><DropdownMenuItem disabled={disabled} onSelect={() => { void toggleAll(true); }}>{t(key('collapseAll'), { defaultValue: 'Collapse all' })}</DropdownMenuItem></>}
          {view !== 'favorites' && <DropdownMenuItem disabled={filtered || !!query.trim() || disabled} onSelect={() => setEditingOrder(true)}>{t(key('editOrder'), { defaultValue: 'Adjust my order' })}</DropdownMenuItem>}
          {(filtered || !!query.trim()) && <p className="max-w-56 px-2 py-2 text-xs text-muted-foreground">{t(key('clearFilters'), { defaultValue: 'Clear filters to reorder.' })}</p>}
        </DropdownMenuContent>
      </DropdownMenu>}
    </div>
    {query.trim() && <p className="shrink-0 px-4 pb-3 text-xs text-muted-foreground">{t('kb.searchAll')}</p>}
    {(navigation.error || navigation.status === 'local' || navigation.status === 'memory' || reorder || message) && <div className="space-y-2 px-4 pb-3 text-xs">
      {navigation.error && <p role="alert" className="text-destructive">{t(key('saveError'), { defaultValue: 'Navigation could not be saved or loaded.' })} <button type="button" className="underline" onClick={() => void navigation.refresh()}>{t('kb.retry')}</button></p>}
      {navigation.status === 'local' && <p role="status" className="text-muted-foreground">{t(key('localOnly'), { defaultValue: 'Saved on this device; reconnect to sync.' })}</p>}
      {navigation.status === 'memory' && <p role="status" className="text-muted-foreground">{t(key('memoryOnly'), { defaultValue: 'Available in this session only.' })}</p>}
      {reorder && <p className="text-muted-foreground">{t(key('orderHint'), { defaultValue: 'Drag or use the row menu. Only your personal order changes.' })}</p>}
      {message && <p role="status" aria-live="polite">{message}</p>}
    </div>}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 pb-4">
      <DndContext sensors={sensors} collisionDetection={siblingCollisions} onDragEnd={onDragEnd}>
        {query.trim() ? results.length ? flat(results) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('kb.noResults')}</p> : view === 'favorites' ? favorites.length ? flat(favorites) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t(key('emptyFavorites'), { defaultValue: 'No favorites in this scope.' })}</p> : view === 'pins' ? pinPages.length ? flat(pinPages, true) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t(key('emptyPins'), { defaultValue: 'No pinned pages in this scope.' })}</p> : visibleGroups.length ? visibleGroups.map(group => {
          const groupPages = scoped.filter(page => (page.project_id || 'shared') === group.id), closed = closedGroups.has(group.id);
          return <section key={group.id} className="mb-3">
            <button type="button" className="mb-1 flex min-h-10 w-full items-center gap-2 rounded-md px-2 text-left text-xs font-medium text-muted-foreground hover:bg-accent" aria-expanded={!closed} aria-label={group.name} onClick={() => setClosedGroups(previous => { const next = new Set(previous); if (next.has(group.id)) next.delete(group.id); else next.add(group.id); return next; })}>{closed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}<FolderOpen size={14} /><span className="min-w-0 flex-1 break-words">{group.name}</span><span className="tabular-nums opacity-70">{groupPages.length}</span></button>
            {!closed && renderNodes(buildKnowledgeTree(groupPages))}
          </section>;
        }) : <p className="px-3 py-8 text-center text-sm text-muted-foreground">{t('kb.emptyGroup')}</p>}
      </DndContext>
    </div>
  </div>;
}
