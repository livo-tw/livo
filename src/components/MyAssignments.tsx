import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { monthDayLabel } from '@/lib/dateLabels';
import { Bug, ListChecks, Search, ArrowRight, RefreshCw, ClipboardCheck, Table2, ArrowLeft } from 'lucide-react';
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
import { assignmentDay, type MyAssignment } from '@/lib/myAssignments';
import MyTasksView from '@/components/MyTasksView';
import { useProjectScope } from '@/hooks/useProjectScope';

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

function AssignmentRow({ item, onOpen, compact = false }: { item: MyAssignment; onOpen: (item: MyAssignment) => void; compact?: boolean }) {
  const { t } = useTranslation();
  const { allProjects } = useProjectContext();
  const day = assignmentDay(item.dueDate), today = assignmentDay(new Date().toISOString());
  const due = day < today ? t('myAssignments.overdue') : day === today ? t('myAssignments.today') : Number.isFinite(day) ? monthDayLabel(new Date(day)) : '';
  return <button type="button" className={`group flex w-full items-start gap-3 border-b border-border/60 text-left transition-colors hover:bg-accent/50 ${compact ? 'px-4 py-3' : 'rounded-lg px-4 py-4'}`} onClick={() => onOpen(item)} aria-label={t('myAssignments.openCard', { title: item.title })}>
    <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${item.kind === 'bug' ? 'bg-destructive/10 text-destructive' : 'bg-primary/10 text-primary'}`}>{item.kind === 'bug' ? <Bug size={16} /> : <ClipboardCheck size={16} />}</span>
    <span className="min-w-0 flex-1"><span className="block break-words text-sm font-medium leading-5">{item.title}</span><span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"><span>{item.reference}</span><span>{allProjects.find(project => project.id === item.projectId)?.name || t('myAssignments.unknownProject')}</span>{item.roles.map(role => <span key={role} className="text-primary">{t(`myAssignments.roles.${role}`)}</span>)}</span>{!compact && <span className="mt-2 inline-flex">{item.issue ? <QaStateBadge state={item.issue.state} /> : item.status ? <StatusBadge name={item.status.name} color={item.status.color} /> : null}</span>}</span>
    <span className="shrink-0 text-right text-xs"><span className={`block ${day <= today ? 'text-destructive' : 'text-muted-foreground'}`}>{due}</span>{compact && <span className="mt-1.5 block max-w-24 break-words text-muted-foreground">{item.issue ? t(`qa.state.${item.issue.state}`) : item.status?.name}</span>}</span>
  </button>;
}

function AssignmentBrowser({ full = false, onNavigate }: { full?: boolean; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const { items: allItems, phase, refresh } = useMyAssignments();
  const { setCurrentView, setSelectedTask } = useUIContext();
  // The full "My tasks" page follows the sidebar scope; the top-bar dropdown always shows all work.
  const { inScope, active: scoped, label: scopeLabel } = useProjectScope();
  const items = full ? allItems.filter(item => inScope(item.projectId)) : allItems;
  const openCard = useOpenAssignment();
  const [kind, setKind] = useState<'all' | 'task' | 'bug'>('all');
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<'all' | 'assigned' | 'review'>('all');
  const { allProjects } = useProjectContext();
  const known = phase === 'ready' || phase === 'disabled';
  const filtered = items.filter(item => (kind === 'all' || item.kind === kind)
    && (role === 'all' || item.roles.some(value => role === 'assigned' ? value === 'assignee' || value === 'fix' : value === 'reviewer' || value === 'verify'))
    && (!query.trim() || [item.title, item.id, item.reference, allProjects.find(project => project.id === item.projectId)?.name || ''].some(value => value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))));
  const shown = full || query.trim() ? filtered : filtered.slice(0, 6);
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className={`${full ? 'px-4 pt-5 md:px-6' : 'px-4 pt-4'} shrink-0`}>
      <div className="flex items-start justify-between gap-3"><div><h2 className="text-base font-semibold">{t('myAssignments.title')}</h2><p className="mt-1 text-xs text-muted-foreground">{known ? t('myAssignments.summary', { count: items.length }) : t(phase === 'error' ? 'myAssignments.partial' : 'myAssignments.loading')} · {full && scoped ? scopeLabel : t('myAssignments.allProjects')}</p></div><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={refresh} aria-label={t('myAssignments.refresh')}><RefreshCw size={15} className={phase === 'loading' ? 'animate-spin' : ''} /></Button></div>
      <div className="my-3 flex gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label={t('myAssignments.typeFilter')}>{(['all', 'task', 'bug'] as const).map(value => <button key={value} type="button" aria-pressed={kind === value} className={`min-h-9 min-w-0 flex-1 rounded-md px-2 text-xs font-medium ${kind === value ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground hover:text-foreground'}`} onClick={() => setKind(value)}>{t(`myAssignments.types.${value}`)} <span className="tabular-nums">{value === 'bug' && !known ? '…' : items.filter(item => value === 'all' || item.kind === value).length}{value === 'all' && !known ? '+' : ''}</span></button>)}</div>
      <div className="mb-3 flex flex-wrap gap-2"><div className="relative min-w-0 flex-1"><Search size={15} className="absolute left-3 top-3 text-muted-foreground" /><Input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('myAssignments.search')} aria-label={t('myAssignments.search')} className="h-10 pl-9" /></div>{full && <SearchableSelect aria-label={t('myAssignments.roleFilter')} className="h-10 max-w-full rounded-md border border-input bg-background px-2 text-sm" value={role} onChange={event => setRole(event.target.value as typeof role)}><option value="all">{t('myAssignments.allRoles')}</option><option value="assigned">{t('myAssignments.assignedRole')}</option><option value="review">{t('myAssignments.reviewRole')}</option></SearchableSelect>}</div>
      {phase === 'error' && <p role="alert" className="mb-3 rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{t('myAssignments.qaFailed')} <button type="button" className="underline" onClick={refresh}>{t('kb.retry')}</button></p>}
    </div>
    <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain ${full ? 'px-4 pb-6 md:px-6' : 'max-h-[min(420px,50vh)]'}`}>
      {shown.map(item => <AssignmentRow key={item.key} item={item} compact={!full} onOpen={selected => { onNavigate?.(); openCard(selected); }} />)}
      {!shown.length && <p className="px-4 py-10 text-center text-sm text-muted-foreground">{t(query.trim() ? 'myAssignments.noResults' : kind !== 'task' && phase === 'loading' ? 'myAssignments.loading' : kind !== 'task' && phase === 'error' ? 'myAssignments.partial' : 'myAssignments.empty')}</p>}
    </div>
    {!full && <button type="button" className="flex min-h-11 shrink-0 items-center justify-between gap-3 border-t px-4 py-3 text-sm font-medium text-primary hover:bg-accent" onClick={() => { onNavigate?.(); const url = new URL(window.location.href); ['qa', 'qaCreate', 'kb', 'anchor', 'knowledge'].forEach(key => url.searchParams.delete(key)); window.history.replaceState({}, '', url.toString()); setSelectedTask(null); setCurrentView('my-tasks'); }}>{t('myAssignments.viewAll')}<ArrowRight size={15} /></button>}
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
    <PopoverTrigger asChild><button type="button" className="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md bg-sidebar-accent/70 px-2.5 text-sidebar-foreground transition-colors hover:bg-sidebar-hover" aria-label={known ? t('myAssignments.trigger', { count: items.length }) : t('myAssignments.triggerLoading')}><ListChecks size={17} aria-hidden="true" />{!isMobile && <span className="text-xs font-medium">{t('myAssignments.title')}</span>}<span className="min-w-5 rounded-md bg-primary px-1.5 py-0.5 text-center text-[11px] font-medium tabular-nums text-primary-foreground" aria-hidden="true">{known ? items.length > 99 ? '99+' : items.length : phase === 'error' ? '?' : '…'}</span></button></PopoverTrigger>
    <PopoverContent align="end" sideOffset={8} collisionPadding={12} className="flex max-h-[var(--radix-popover-content-available-height)] w-[min(428px,calc(100vw-24px))] flex-col overflow-hidden p-0" onCloseAutoFocus={event => { if (navigating.current) event.preventDefault(); navigating.current = false; }}><AssignmentBrowser onNavigate={() => { navigating.current = true; setOpen(false); }} /></PopoverContent>
  </Popover>;
}

export default function MyAssignmentsView() {
  const { t } = useTranslation();
  const [table, setTable] = useState(false);
  return <section className="flex min-h-0 flex-1 flex-col bg-gradient-to-b from-primary/[0.025] to-background">
    <div className="flex shrink-0 justify-end px-4 pt-3 md:px-6"><Button size="sm" variant="ghost" className="gap-2" onClick={() => setTable(previous => !previous)}>{table ? <ArrowLeft size={14} /> : <Table2 size={14} />}{t(table ? 'myAssignments.backToAssignments' : 'myAssignments.taskTable')}</Button></div>
    {table ? <MyTasksView /> : <AssignmentBrowser full />}
  </section>;
}
