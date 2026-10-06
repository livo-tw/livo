import { useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { monthDayLabel } from '@/lib/dateLabels';
import { Bug, ListChecks, Search, ArrowRight, RefreshCw, ClipboardCheck, Table2, ArrowLeft, CalendarClock, AlertTriangle, Inbox } from 'lucide-react';
import { useMyAssignments } from '@/context/MyAssignmentsContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useUIContext } from '@/context/UIContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { QaStateBadge } from '@/components/qa/QaBadges';
import { StatusBadge } from '@/components/ui/badges';
import { assignmentBucket, assignmentDay, groupAssignments, type AssignmentBucket, type MyAssignment } from '@/lib/myAssignments';
import MyTasksView from '@/components/MyTasksView';
import { useProjectScope } from '@/hooks/useProjectScope';

type Kind = 'all' | 'task' | 'bug';
const COARSE_TARGET = '[@media(pointer:coarse)]:min-h-11';
const BUCKET_DOT: Record<AssignmentBucket, string> = { overdue: 'bg-destructive', today: 'bg-amber-500', upcoming: 'bg-primary', none: 'bg-muted-foreground/50' };
const DUE_CHIP: Record<AssignmentBucket, string> = {
  overdue: 'bg-destructive/10 text-destructive',
  today: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  upcoming: 'bg-muted-foreground/10 text-muted-foreground',
  none: '',
};

function useOpenAssignment() {
  const { currentView, setCurrentView, setSelectedTask } = useUIContext();
  return (item: MyAssignment) => {
    const url = new URL(window.location.href);
    ['qa', 'qaCreate', 'kb', 'anchor', 'knowledge', 'task'].forEach(key => url.searchParams.delete(key));
    if (item.issue) {
      url.searchParams.set('qa', item.id); window.history.pushState({}, '', url.toString());
      setSelectedTask(null); setCurrentView('qa'); window.dispatchEvent(new Event('livo:qa-navigation'));
    } else if (item.task) {
      window.history.replaceState({}, '', url.toString());
      if (!['board', 'all-list', 'my-tasks', 'gantt', 'backlog', 'dashboard'].includes(currentView)) setCurrentView('my-tasks');
      setSelectedTask(item.task);
    }
  };
}

/** "Today", or the short month/day of the due date; empty when there is none. */
function useDueLabel(item: MyAssignment) {
  const { t } = useTranslation();
  const bucket = assignmentBucket(item.dueDate);
  const label = bucket === 'today' ? t('myAssignments.today') : bucket === 'none' ? '' : monthDayLabel(new Date(assignmentDay(item.dueDate)));
  return { bucket, label };
}

function KindIcon({ item, className = 'h-8 w-8' }: { item: MyAssignment; className?: string }) {
  return <span aria-hidden="true" className={`flex shrink-0 items-center justify-center rounded-lg ${className} ${item.kind === 'bug' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{item.kind === 'bug' ? <Bug size={16} /> : <ClipboardCheck size={16} />}</span>;
}

function StateBadge({ item }: { item: MyAssignment }) {
  return item.issue ? <QaStateBadge state={item.issue.state} /> : item.status ? <StatusBadge name={item.status.name} color={item.status.color} /> : null;
}

/** Compact row for the top-bar popover. */
function AssignmentRow({ item, onOpen }: { item: MyAssignment; onOpen: (item: MyAssignment) => void }) {
  const { t } = useTranslation();
  const { allProjects } = useProjectContext();
  const { bucket, label } = useDueLabel(item);
  const due = bucket === 'overdue' ? t('myAssignments.overdue') : label;
  return <button type="button" className="group flex w-full items-start gap-3 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none" onClick={() => onOpen(item)} aria-label={t('myAssignments.openCard', { title: item.title })}>
    <KindIcon item={item} className="mt-0.5 h-8 w-8" />
    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium leading-5">{item.title}</span><span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{item.reference}</span><span>{allProjects.find(project => project.id === item.projectId)?.name || t('myAssignments.unknownProject')}</span>{item.roles.map(role => <span key={role} className="text-primary">{t(`myAssignments.roles.${role}`)}</span>)}</span></span>
    <span className="shrink-0 text-right text-xs"><span className={`block ${bucket === 'overdue' || bucket === 'today' ? 'text-destructive' : 'text-muted-foreground'}`}>{due}</span><span className="mt-1.5 block max-w-24 break-words text-muted-foreground">{item.issue ? t(`qa.state.${item.issue.state}`) : item.status?.name}</span></span>
  </button>;
}

/** Card for the full page: one line of identity on the left, state and due date on the right. */
function AssignmentCard({ item, onOpen }: { item: MyAssignment; onOpen: (item: MyAssignment) => void }) {
  const { t } = useTranslation();
  const { allProjects } = useProjectContext();
  const project = allProjects.find(row => row.id === item.projectId);
  const { bucket, label } = useDueLabel(item);
  return <button type="button" onClick={() => onOpen(item)} aria-label={t('myAssignments.openCard', { title: item.title })}
    className="grid w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-3 text-left text-card-foreground shadow-sm transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:grid-cols-[auto_minmax(0,1fr)_auto]">
    <KindIcon item={item} className="h-9 w-9 self-start sm:self-center" />
    <span className="min-w-0">
      <span className="block break-words text-sm font-medium leading-5 md:text-[15px]">{item.title}</span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium tabular-nums">{item.reference}</span>
        <span className="inline-flex min-w-0 items-center gap-1.5"><span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: project?.color || 'hsl(var(--muted-foreground))' }} /><span className="truncate">{project?.name || t('myAssignments.unknownProject')}</span></span>
        {item.roles.map(role => <span key={role} className="rounded-md bg-primary/10 px-1.5 py-px font-medium text-primary">{t(`myAssignments.roles.${role}`)}</span>)}
      </span>
    </span>
    <span className="col-start-2 flex flex-wrap items-center gap-2 sm:col-start-3 sm:flex-nowrap sm:justify-end">
      <StateBadge item={item} />
      {label && <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium tabular-nums ${DUE_CHIP[bucket]}`} title={t('myAssignments.dueDate', { date: monthDayLabel(new Date(assignmentDay(item.dueDate))) })}>
        {bucket === 'overdue' ? <AlertTriangle size={12} aria-hidden="true" /> : <CalendarClock size={12} aria-hidden="true" />}{label}
      </span>}
    </span>
  </button>;
}

/** Underlined type tabs with count pills; `stretch` fills the popover width. */
function TypeTabs({ kind, onChange, counts, stretch = false }: { kind: Kind; onChange: (kind: Kind) => void; counts: Record<Kind, string>; stretch?: boolean }) {
  const { t } = useTranslation();
  return <div className={`flex gap-1 border-b border-border ${stretch ? '' : 'overflow-x-auto'}`} role="group" aria-label={t('myAssignments.typeFilter')}>
    {(['all', 'task', 'bug'] as const).map(value => {
      const active = kind === value;
      return <button key={value} type="button" aria-pressed={active} onClick={() => onChange(value)}
        className={`-mb-px inline-flex min-h-10 items-center justify-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${COARSE_TARGET} ${stretch ? 'min-w-0 flex-1' : ''} ${active ? 'border-primary text-primary' : 'border-transparent text-muted-foreground hover:border-border hover:text-foreground'}`}>
        {t(`myAssignments.types.${value}`)}
        <span className={`min-w-6 rounded-full px-1.5 py-px text-center text-xs font-semibold tabular-nums ${active ? 'bg-primary text-primary-foreground' : 'bg-muted-foreground/15 text-muted-foreground'}`}>{counts[value]}</span>
      </button>;
    })}
  </div>;
}

function SectionHeader({ bucket, count }: { bucket: AssignmentBucket; count: number }) {
  const { t } = useTranslation();
  return <h3 className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold text-muted-foreground">
    <span aria-hidden="true" className={`h-2 w-2 rounded-full ${BUCKET_DOT[bucket]}`} />{t(`myAssignments.sections.${bucket}`)}
    <span className="rounded-full bg-muted-foreground/15 px-1.5 py-px tabular-nums">{count}</span>
  </h3>;
}

function AssignmentBrowser({ full = false, onNavigate, actions }: { full?: boolean; onNavigate?: () => void; actions?: ReactNode }) {
  const { t } = useTranslation();
  const { items: allItems, phase, refresh } = useMyAssignments();
  const { setCurrentView, setSelectedTask } = useUIContext();
  // The full "My tasks" page follows the sidebar scope; the top-bar dropdown always shows all work.
  const { inScope, active: scoped, label: scopeLabel } = useProjectScope();
  const items = full ? allItems.filter(item => inScope(item.projectId)) : allItems;
  const openCard = useOpenAssignment();
  const [kind, setKind] = useState<Kind>('all');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | 'assigned' | 'review'>('all');
  const { allProjects } = useProjectContext();
  const known = phase === 'ready' || phase === 'disabled';
  const filtered = items.filter(item => (kind === 'all' || item.kind === kind)
    && (role === 'all' || item.roles.some(value => role === 'assigned' ? value === 'assignee' || value === 'fix' : value === 'reviewer' || value === 'verify'))
    && (!query.trim() || [item.title, item.id, item.reference, allProjects.find(project => project.id === item.projectId)?.name || ''].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
  const shown = full || query.trim() ? filtered : filtered.slice(0, 6);
  const counts = Object.fromEntries((['all', 'task', 'bug'] as const).map(value => [value,
    value === 'bug' && !known ? '…' : `${items.filter(item => value === 'all' || item.kind === value).length}${value === 'all' && !known ? '+' : ''}`])) as Record<Kind, string>;
  const open = (selected: MyAssignment) => { onNavigate?.(); openCard(selected); };
  const emptyText = t(query.trim() ? 'myAssignments.noResults' : kind !== 'task' && phase === 'loading' ? 'myAssignments.loading' : kind !== 'task' && phase === 'error' ? 'myAssignments.partial' : 'myAssignments.empty');
  const summary = <>{known ? t('myAssignments.summary', { count: items.length }) : t(phase === 'error' ? 'myAssignments.partial' : 'myAssignments.loading')} · {full && scoped ? scopeLabel : t('myAssignments.allProjects')}</>;
  const refreshButton = <Button variant={full ? 'outline' : 'ghost'} size="icon" className={`shrink-0 ${full ? 'h-9 w-9 bg-card' : 'h-8 w-8'} [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11`} onClick={refresh} aria-label={t('myAssignments.refresh')} title={t('myAssignments.refresh')}><RefreshCw size={15} className={phase === 'loading' ? 'animate-spin' : ''} /></Button>;
  const searchBox = <div className="relative min-w-0 flex-1"><Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" aria-hidden="true" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('myAssignments.search')} aria-label={t('myAssignments.search')} className={`h-10 pl-9 ${full ? 'bg-card' : ''}`} /></div>;
  const errorNote = phase === 'error' && <p role="alert" className="rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-xs text-destructive">{t('myAssignments.qaFailed')} <button type="button" className="font-medium underline underline-offset-2" onClick={refresh}>{t('kb.retry')}</button></p>;

  if (!full) return <div className="flex min-h-0 flex-1 flex-col">
    <div className="shrink-0 px-4 pt-4">
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{t('myAssignments.title')}</h2><p className="mt-1 text-xs text-muted-foreground">{summary}</p></div>{refreshButton}</div>
      <div className="my-3"><TypeTabs kind={kind} onChange={setKind} counts={counts} stretch /></div>
      <div className="mb-3">{searchBox}</div>
      {errorNote && <div className="mb-3">{errorNote}</div>}
    </div>
    <div className="max-h-[min(420px,50vh)] min-h-0 flex-1 overflow-y-auto overscroll-contain">
      {shown.map(item => <AssignmentRow key={item.key} item={item} onOpen={open} />)}
      {!shown.length && <p className="px-4 py-10 text-center text-sm text-muted-foreground">{emptyText}</p>}
    </div>
    <button type="button" className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-t px-4 py-3 text-sm font-medium text-primary hover:bg-accent" onClick={() => { onNavigate?.(); const url = new URL(window.location.href); ['qa', 'qaCreate', 'kb', 'anchor', 'knowledge'].forEach(key => url.searchParams.delete(key)); window.history.replaceState({}, '', url.toString()); setSelectedTask(null); setCurrentView('my-tasks'); }}>{t('myAssignments.viewAll')}<ArrowRight size={15} /></button>
  </div>;

  return <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    <div className="mx-auto w-full max-w-5xl px-4 pb-10 pt-5 md:px-8 md:pt-7">
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0"><h2 className="text-xl font-semibold tracking-tight">{t('myAssignments.title')}</h2><p className="mt-1 text-sm text-muted-foreground">{summary}</p></div>
        <div className="flex shrink-0 items-center gap-2">{actions}{refreshButton}</div>
      </header>
      <div className="mt-5 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <TypeTabs kind={kind} onChange={setKind} counts={counts} />
        <div className="flex flex-wrap gap-2 lg:w-[460px] lg:flex-nowrap">{searchBox}<SearchableSelect aria-label={t('myAssignments.roleFilter')} className="h-10 max-w-full rounded-md border border-input bg-card px-3 text-sm" value={role} onChange={event => setRole(event.target.value as typeof role)}><option value="all">{t('myAssignments.allRoles')}</option><option value="assigned">{t('myAssignments.assignedRole')}</option><option value="review">{t('myAssignments.reviewRole')}</option></SearchableSelect></div>
      </div>
      {errorNote && <div className="mt-4">{errorNote}</div>}
      {shown.length > 0 && <div className="mt-6 space-y-6">
        {groupAssignments(shown).map(group => <section key={group.bucket} aria-label={t(`myAssignments.sections.${group.bucket}`)}>
          <SectionHeader bucket={group.bucket} count={group.items.length} />
          <ul className="space-y-2">{group.items.map(item => <li key={item.key}><AssignmentCard item={item} onOpen={open} /></li>)}</ul>
        </section>)}
      </div>}
      {!shown.length && <div className="mt-6 flex flex-col items-center gap-3 rounded-xl border border-dashed border-border bg-card/60 px-6 py-14 text-center">
        <span aria-hidden="true" className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">{phase === 'loading' && kind !== 'task' && !query.trim() ? <RefreshCw size={18} className="animate-spin" /> : <Inbox size={18} />}</span>
        <p className="text-sm text-muted-foreground">{emptyText}</p>
      </div>}
    </div>
  </div>;
}

export function MyAssignmentsDropdown() {
  const { t } = useTranslation();
  const { items, phase } = useMyAssignments();
  const [open, setOpen] = useState(false);
  const navigating = useRef(false);
  const isMobile = useIsMobile();
  const known = phase === 'ready' || phase === 'disabled';
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger asChild><button type="button" className="relative flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-md bg-sidebar-accent/70 text-sidebar-foreground transition-colors hover:bg-sidebar-hover md:w-auto md:px-2.5" aria-label={known ? t('myAssignments.trigger', { count: items.length }) : t('myAssignments.triggerLoading')}><ListChecks size={20} aria-hidden="true" />{!isMobile && <span className="text-xs font-medium">{t('myAssignments.title')}</span>}<span className="absolute -right-0.5 -top-0.5 min-w-5 rounded-md bg-primary px-1 py-0.5 text-center text-[11px] font-medium tabular-nums text-primary-foreground md:static md:px-1.5" aria-hidden="true">{known ? items.length > 99 ? '99+' : items.length : phase === 'error' ? '?' : '…'}</span></button></PopoverTrigger>
    <PopoverContent align="end" sideOffset={8} collisionPadding={12} className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(428px,calc(100vw-24px))] flex-col overflow-hidden p-0" onCloseAutoFocus={event => { if (navigating.current) event.preventDefault(); navigating.current = false; }}><AssignmentBrowser onNavigate={() => { navigating.current = true; setOpen(false); }} /></PopoverContent>
  </Popover>;
}

export default function MyAssignmentsView() {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  return <section className="flex min-h-0 flex-1 flex-col bg-background">
    {table ? <>
      <div className="flex shrink-0 px-4 pt-3 md:px-6"><Button size="sm" variant="ghost" className="gap-2" onClick={() => setTable(false)}><ArrowLeft size={14} />{t('myAssignments.backToAssignments')}</Button></div>
      <MyTasksView />
    </> : <AssignmentBrowser full actions={<Button size="sm" variant="outline" className="h-9 gap-2 bg-card px-2.5 sm:px-3 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:min-w-11" onClick={() => setTable(true)} aria-label={t('myAssignments.taskTable')} title={t('myAssignments.taskTable')}><Table2 size={14} /><span className="hidden sm:inline">{t('myAssignments.taskTable')}</span></Button>} />}
  </section>;
}
