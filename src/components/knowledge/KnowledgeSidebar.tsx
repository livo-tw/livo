import { Search, SlidersHorizontal, X } from 'lucide-react';
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
export default function KnowledgeSidebar({ selected, query, onQuery, scope, onScope, scopeOptions, scopeLabel, category, onCategory, archived, onArchived, children }: Props) {
  const { t } = useTranslation();
  const active = Number(scope !== 'all') + Number(category !== 'all') + Number(archived);
  const reset = () => { onScope('all'); onCategory('all'); onArchived(false); };
  return <aside className={`${selected ? 'hidden md:flex' : 'flex'} w-full shrink-0 flex-col border-r bg-card md:w-80 xl:w-[352px]`} aria-label={t('kb.pages')}>
    <div className="shrink-0 space-y-3 px-4 pb-3 pt-4">
      <div className="relative"><Search size={16} className="pointer-events-none absolute left-3 top-3 text-muted-foreground" aria-hidden="true" /><Input value={query} onChange={event => onQuery(event.target.value)} placeholder={t('kb.search')} aria-label={t('kb.search')} className="h-10 bg-muted/40 pl-9 pr-9" />{query && <button type="button" onClick={() => onQuery('')} className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent" aria-label={t('kb.navigation.clearSearch')}><X size={14} /></button>}</div>
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
  </aside>;
}
