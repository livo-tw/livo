import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Loader2, Search } from 'lucide-react';
import { qaShortId } from '@/lib/qa/shortId';
import { knowledgeWorkflowRequest } from '@/lib/knowledgeWorkflowClient';

export type KnowledgeWorkTarget = { id: string; title: string; key: string };
type Kind = 'task' | 'qa';

/** QA ids are UUIDs; show the same short form as the QA board card. */
const knowledgeTargetLabel = (kind: Kind, item: KnowledgeWorkTarget) => kind === 'qa' ? `${qaShortId(item.id)} · ${item.title}` : `${item.key} · ${item.title}`;

/**
 * Pick an existing task or bug: the list opens on focus (no typing needed) and
 * narrows as you type. The server returns at most 50 matches the page editor may link.
 */
export function KnowledgeWorkTargetPicker({ pageId, disabled, onPick }: { pageId: string; disabled: boolean; onPick: (kind: Kind, item: KnowledgeWorkTarget) => void }) {
  const { t } = useTranslation();
  const listId = useId();
  const [kind, setKind] = useState<Kind>('task');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<KnowledgeWorkTarget[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [active, setActive] = useState(0);
  const request = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const ticket = ++request.current;
    setLoading(true); setFailed(false);
    const timer = window.setTimeout(() => {
      void knowledgeWorkflowRequest<{ items: KnowledgeWorkTarget[] }>({ action: 'search_targets', pageId, targetKind: kind, query: query.trim() })
        .then(result => { if (ticket === request.current) { setItems(result.items); setActive(0); } })
        .catch(() => { if (ticket === request.current) { setItems([]); setFailed(true); } })
        .finally(() => { if (ticket === request.current) setLoading(false); });
    }, query ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [open, kind, query, pageId]);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  const pick = (item: KnowledgeWorkTarget | undefined) => { if (!item || disabled) return; setOpen(false); setQuery(''); onPick(kind, item); };
  return <div ref={box} className="space-y-2">
    <div className="inline-flex rounded-lg bg-muted/70 p-1" role="group" aria-label={t('kbWorkflow.targetType')}>
      {(['task', 'qa'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} disabled={disabled}
        className={`rounded-md px-3 py-1 text-sm font-medium ${kind === value ? 'bg-background text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`}
        onClick={() => { setKind(value); setItems([]); setOpen(true); }}>{t(value === 'task' ? 'kbWorkflow.task' : 'kbWorkflow.bug')}</button>)}
    </div>
    <div className="relative">
      <Search size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      <input role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" aria-label={t('kbWorkflow.search')}
        aria-activedescendant={open && items[active] ? `${listId}-${items[active].id}` : undefined}
        disabled={disabled} value={query} maxLength={200} placeholder={t('kbWorkflow.pickPlaceholder')}
        className="h-10 w-full rounded-md border border-input bg-background pl-8 pr-8 text-sm outline-none focus-visible:ring-2 focus-visible:ring-primary"
        onFocus={() => setOpen(true)} onClick={() => setOpen(true)} onChange={event => { setQuery(event.target.value); setOpen(true); }}
        onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => Math.min(index + 1, Math.max(items.length - 1, 0))); }
          else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
          // While a search is running the list is stale; Enter must not pick from it.
          else if (event.key === 'Enter' && open) { event.preventDefault(); if (!loading) pick(items[active]); }
          else if (event.key === 'Escape') setOpen(false);
        }} />
      <ChevronDown size={15} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
      {open && <ul id={listId} role="listbox" aria-label={t(kind === 'task' ? 'kbWorkflow.task' : 'kbWorkflow.bug')}
        className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 text-sm shadow-lg">
        {loading && <li role="presentation" className="flex items-center gap-2 px-2 py-2 text-muted-foreground"><Loader2 size={14} className="animate-spin" aria-hidden="true" />{t('kbWorkflow.searching')}</li>}
        {!loading && failed && <li role="presentation" className="px-2 py-2 text-destructive">{t('kbWorkflow.failed')}</li>}
        {!loading && !failed && !items.length && <li role="presentation" className="px-2 py-2 text-muted-foreground">{t('kbWorkflow.noTargets')}</li>}
        {!loading && items.map((item, index) => <li key={item.id} id={`${listId}-${item.id}`} role="option" aria-selected={index === active}
          className={`cursor-pointer truncate rounded px-2 py-2 ${index === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
          onPointerEnter={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => pick(item)}>{knowledgeTargetLabel(kind, item)}</li>)}
      </ul>}
    </div>
  </div>;
}
