import { ArrowUpDown, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { BOARD_SORT_FIELDS, boardSortDefaultDirection, type BoardSort, type BoardSortDirection } from '@/lib/boardSort';
import { useIsMobile } from '@/hooks/use-mobile';

/** One sort control for the task board and the QA board. */
export default function BoardSortMenu({ value, onChange, defaultLabel, disabled = false }: {
  value: BoardSort; onChange: (sort: BoardSort) => void;
  /** What "default" means on this board, e.g. "most recently updated". */
  defaultLabel?: string; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const fieldLabel = (field: BoardSort['field']) => field === 'default' && defaultLabel ? defaultLabel : t(`boardSort.fields.${field}`);
  const directions: BoardSortDirection[] = value.field === 'dueDate' ? ['asc', 'desc'] : ['desc', 'asc'];
  const active = value.field !== 'default';
  return <DropdownMenu>
    <DropdownMenuTrigger asChild>
      <button type="button" disabled={disabled} aria-label={t('boardSort.current', { field: fieldLabel(value.field) })}
        className={`flex items-center gap-1 px-2 py-1.5 text-[13px] font-medium rounded-md border transition-colors disabled:opacity-50 ${active ? 'bg-primary/10 text-primary border-primary/30' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'}`}>
        <ArrowUpDown size={14} aria-hidden="true" />
        {!isMobile && <span>{active ? fieldLabel(value.field) : t('boardSort.button')}</span>}
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" className="w-52">
      <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('boardSort.title')}</p>
      {BOARD_SORT_FIELDS.map(field => <DropdownMenuItem key={field} role="menuitemradio" aria-checked={value.field === field}
        onSelect={() => onChange({ field, direction: boardSortDefaultDirection(field) })}>
        <Check size={14} className={value.field === field ? 'opacity-100' : 'opacity-0'} aria-hidden="true" />{fieldLabel(field)}
      </DropdownMenuItem>)}
      {active && <>
        <div role="separator" className="-mx-1 my-1 h-px bg-border" />
        <p className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{t('boardSort.order')}</p>
        {directions.map(direction => <DropdownMenuItem key={direction} role="menuitemradio" aria-checked={value.direction === direction}
          onSelect={() => onChange({ ...value, direction })}>
          <Check size={14} className={value.direction === direction ? 'opacity-100' : 'opacity-0'} aria-hidden="true" />{t(`boardSort.directions.${value.field}.${direction}`)}
        </DropdownMenuItem>)}
      </>}
    </DropdownMenuContent>
  </DropdownMenu>;
}
