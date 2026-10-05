import { useRef, useState } from 'react';
import { PanelLeftClose, PanelLeftOpen, Search, SlidersHorizontal, X } from 'lucide-react';
import { IconAction } from '@/components/ui/icon-action';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

type Props = {
  selected: boolean; query: string; onQuery: (query: string) => void;
  scope: string; onScope: (scope: string) => void; scopeOptions: React.ReactNode; scopeLabel: string;
  category: string; onCategory: (category: 'all' | 'general' | 'meeting') => void;
  archived: boolean; onArchived: (archived: boolean) => void; children: React.ReactNode;
};
const WIDTH = { min: 256, max: 560, initial: 320 };
const LAYOUT_KEY = 'livo.kb.sidebar';
/** Width and collapsed state are a per-device preference; blocked storage falls back to the default. */
function readLayout(): { width: number; collapsed: boolean } {
  try {
    const value = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null') as { width?: unknown; collapsed?: unknown } | null;
    const width = typeof value?.width === 'number' ? Math.min(WIDTH.max, Math.max(WIDTH.min, value.width)) : WIDTH.initial;
    return { width, collapsed: value?.collapsed === true };
  } catch { return { width: WIDTH.initial, collapsed: false }; }
}
function writeLayout(layout: { width: number; collapsed: boolean }) {
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)); } catch { /* still applies until reload */ }
}

export default function KnowledgeSidebar({ selected, query, onQuery, scope, onScope, scopeOptions, scopeLabel, category, onCategory, archived, onArchived, children }: Props) {
  const { t } = useTranslation();
  const active = Number(scope !== 'all') + Number(category !== 'all') + Number(archived);
  const reset = () => { onScope('all'); onCategory('all'); onArchived(false); };
  const [layout, setLayoutState] = useState(readLayout);
  const setLayout = (next: { width: number; collapsed: boolean }) => { setLayoutState(next); writeLayout(next); };
  const aside = useRef<HTMLElement>(null);
  const resizeTo = (width: number) => setLayout({ ...layout, width: Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, width))) });
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const left = aside.current?.getBoundingClientRect().left ?? 0;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const move = (moved: PointerEvent) => setLayoutState(current => ({ ...current, width: Math.round(Math.min(WIDTH.max, Math.max(WIDTH.min, moved.clientX - left))) }));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); setLayoutState(current => { writeLayout(current); return current; }); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end);
  };
  // Collapsing applies to wide screens only; phones keep the list/page switch.
  const display = layout.collapsed ? (selected ? 'hidden' : 'flex md:hidden') : (selected ? 'hidden md:flex' : 'flex');
  return <>
  {layout.collapsed && <div className="hidden w-11 shrink-0 flex-col items-center border-r bg-card py-3 md:flex">
    <IconAction label={t('kb.navigation.expandSidebar')} onClick={() => setLayout({ ...layout, collapsed: false })}><PanelLeftOpen size={16} /></IconAction>
  </div>}
  <aside ref={aside} style={{ '--kb-sidebar': `${layout.width}px` } as React.CSSProperties} className={`${display} relative w-full shrink-0 flex-col border-r bg-card md:w-[var(--kb-sidebar)]`} aria-label={t('kb.pages')}>
    <div className="shrink-0 space-y-3 px-4 pb-3 pt-4">
      <div className="flex items-center gap-1"><div className="relative min-w-0 flex-1"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" aria-hidden="true" /><Input value={query} onChange={event => onQuery(event.target.value)} placeholder={t('kb.search')} aria-label={t('kb.search')} className="h-10 bg-muted/40 pl-9 pr-9" />{query && <button type="button" onClick={() => onQuery('')} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" aria-label={t('kb.navigation.clearSearch')}><X size={14} /></button>}</div>
        <span className="hidden md:inline-flex"><IconAction label={t('kb.navigation.collapseSidebar')} onClick={() => setLayout({ ...layout, collapsed: true })}><PanelLeftClose size={16} /></IconAction></span></div>
      <div className="flex items-center justify-between gap-2">
        <Popover><PopoverTrigger asChild><Button variant="outline" size="sm" className="h-8 gap-2 text-xs"><SlidersHorizontal size={14} />{t('kb.navigation.filters')}{active > 0 && <span className="rounded bg-primary/10 px-1.5 text-primary" aria-label={t('kb.navigation.activeFilters', { count: active })}>{active}</span>}</Button></PopoverTrigger>
          <PopoverContent align="start" className="w-[min(320px,calc(100vw-32px))] space-y-4 p-4">
            <h2 className="text-sm font-semibold">{t('kb.navigation.filters')}</h2>
            <label className="block space-y-1.5 text-xs font-medium">{t('kb.scope')}<SearchableSelect className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={scope} onChange={event => onScope(event.target.value)}><option value="all">{t('kb.allScopes')}</option>{scopeOptions}</SearchableSelect></label>
            <label className="block space-y-1.5 text-xs font-medium">{t('kb.category')}<SearchableSelect className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm" value={category} onChange={event => onCategory(event.target.value as 'all' | 'general' | 'meeting')}><option value="all">{t('kb.allCategories')}</option><option value="general">{t('kb.categories.general')}</option><option value="meeting">{t('kb.categories.meeting')}</option></SearchableSelect></label>
            <label className="flex min-h-10 items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={event => onArchived(event.target.checked)} />{t('kb.showArchived')}</label>
            {active > 0 && <Button type="button" variant="ghost" size="sm" onClick={reset}>{t('kb.navigation.clearFiltersAction')}</Button>}
          </PopoverContent>
        </Popover>
        <span className="min-w-0 truncate text-xs text-muted-foreground" title={scopeLabel}>{scopeLabel}</span>
      </div>
      {active > 0 && <div className="flex flex-wrap items-center gap-1.5 text-xs" aria-label={t('kb.navigation.activeFilters', { count: active })}>
        {scope !== 'all' && <button type="button" onClick={() => onScope('all')} className="flex min-h-8 max-w-full items-center gap-1.5 rounded-md bg-primary/10 px-2 text-primary" aria-label={t('kb.navigation.removeScope')}><span className="min-w-0 truncate">{scopeLabel}</span><X size={12} /></button>}
        {category !== 'all' && <button type="button" onClick={() => onCategory('all')} className="flex min-h-8 items-center gap-1.5 rounded-md bg-muted px-2" aria-label={t('kb.navigation.removeCategory')}>{t(`kb.categories.${category}`)}<X size={12} /></button>}
        {archived && <button type="button" onClick={() => onArchived(false)} className="flex min-h-8 items-center gap-1.5 rounded-md bg-muted px-2" aria-label={t('kb.navigation.hideArchived')}>{t('kb.archived')}<X size={12} /></button>}
      </div>}
    </div>
    {children}
    <div role="separator" aria-orientation="vertical" aria-label={t('kb.navigation.resizeSidebar')} aria-valuemin={WIDTH.min} aria-valuemax={WIDTH.max} aria-valuenow={layout.width} tabIndex={0}
      title={t('kb.navigation.resizeSidebar')} onPointerDown={startResize} onDoubleClick={() => resizeTo(WIDTH.initial)}
      onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); resizeTo(layout.width + (event.key === 'ArrowRight' ? 16 : -16)); } }}
      className="absolute inset-y-0 -right-1 z-10 hidden w-2 cursor-col-resize touch-none outline-none hover:bg-primary/20 focus-visible:bg-primary/30 md:block" />
  </aside>
  </>;
}
