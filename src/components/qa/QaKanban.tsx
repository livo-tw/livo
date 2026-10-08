import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQaNavigationGuard } from '@/hooks/useQaNavigationGuard';
import { toast } from 'sonner';
import { GripVertical, Inbox } from 'lucide-react';
import { DndContext, DragOverlay, useDraggable, useDroppable, closestCenter, pointerWithin, type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import { useBoardSensors } from '@/hooks/useBoardSensors';
import QaIssueCard from './QaIssueCard';
import { useQaDisplayConfiguration } from '@/context/QaDisplaySettingsContext';
import { getQaBoardStates } from '@/lib/qa/displaySettings';
import { qaStateColors } from './QaBadges';
import { isQaTerminal, type QaActor, type QaCommand, type QaIssue, type QaListInput, type QaListResult, type QaState } from '@/lib/qa/domain';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { qaId, type QaClient } from '@/lib/qa/client';
import { getQaDropIntent, type QaActionDefaults } from '@/lib/qa/boardInteraction';
import { getQaStateLabel, getQaWorkflowColumns, type QaWorkflow } from '@/lib/qa/workflow';
import { QaFailure } from './QaIssueDetail';
import { qaButton } from './QaFields';

// Move by column with the keyboard, including columns outside the horizontal viewport.
const columnCoordinates: KeyboardCoordinateGetter = (event, { currentCoordinates, context }) => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.code) || !context.collisionRect) return;
  event.preventDefault();
  const columns = context.droppableContainers.getEnabled().map(column => ({ id: column.id, rect: context.droppableRects.get(column.id) }))
    .filter((column): column is { id: typeof column.id; rect: NonNullable<typeof column.rect> } => !!column.rect)
    .sort((a, b) => a.rect.left - b.rect.left);
  const centre = context.collisionRect.left + context.collisionRect.width / 2;
  const current = context.over ? columns.findIndex(column => column.id === context.over!.id) : columns.reduce((nearest, column, index) =>
    Math.abs(column.rect.left + column.rect.width / 2 - centre) < Math.abs(columns[nearest].rect.left + columns[nearest].rect.width / 2 - centre) ? index : nearest, 0);
  const target = columns[current + (event.code === 'ArrowRight' ? 1 : -1)];
  if (!target) return;
  return { x: currentCoordinates.x + target.rect.left + target.rect.width / 2 - centre,
    y: currentCoordinates.y + target.rect.top + Math.min(target.rect.height / 2, 100) - (context.collisionRect.top + context.collisionRect.height / 2) };
};

const columnCollision: CollisionDetection = args => args.pointerCoordinates ? pointerWithin(args) : closestCenter(args);

interface QaBoardMove { issue: QaIssue; fromState: QaState; state: QaState; acknowledgedRevision?: number }

export default function QaKanban({ client, actor, workflow, filters, reloadToken = 0, onOpen, onPendingChange }: {
  client: QaClient;
  actor: QaActor;
  workflow: QaWorkflow;
  filters: QaListInput;
  /** Changes when a bug was created or changed elsewhere (the detail view); the columns reload in place. */
  reloadToken?: number;
  onOpen: (id: string, action?: QaCommand['type'], defaults?: QaActionDefaults) => void;
  onPendingChange?: (pending: boolean) => void;
}) {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [active, setActive] = useState<QaIssue | null>(null), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [failure, setFailure] = useState<{ error: unknown; issue: QaIssue; uncertain: boolean } | null>(null);
  const [move, setMove] = useState<QaBoardMove | null>(null);
  const request = useRef<{ issue: QaIssue; command: Extract<QaCommand, { type: 'set_state' }>; id: string; label: string } | null>(null);
  const refreshRequest = useRef<{ revision: number; remaining: Set<QaState> } | null>(null);
  const revisionNumber = useRef(0);
  const mounted = useRef(true), sending = useRef(false);
  useQaNavigationGuard(busy || !!failure?.uncertain);
  const pendingOperation = busy || refreshing || !!failure?.uncertain;
  useEffect(() => { onPendingChange?.(pendingOperation); return () => onPendingChange?.(false); }, [pendingOperation, onPendingChange]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  // A status filter keeps only the columns, and the states within a column, it selects.
  const configuration = useQaDisplayConfiguration();
  const selectedStates = filters.states || (filters.state ? [filters.state] : null);
  const columns = getQaWorkflowColumns(workflow, state => t(`qa.state.${state}`))
    .map(column => ({ ...column, shown: configuration ? getQaBoardStates(configuration, column.states, selectedStates) : [] }))
    .filter(column => column.shown.length > 0);
  const sensors = useBoardSensors(columnCoordinates);
  const columnLoaded = useCallback((state: QaState, loadedRevision: number) => {
    const refreshing = refreshRequest.current;
    if (!refreshing || refreshing.revision !== loadedRevision) return;
    refreshing.remaining.delete(state);
    if (!refreshing.remaining.size) {
      refreshRequest.current = null;
      if (mounted.current) { setMove(null); setRefreshing(false); }
    }
  }, []);
  const refreshBoard = () => {
    if (request.current) toast.dismiss(`qa-move-${request.current.id}`);
    request.current = null; setFailure(null); setMove(null);
    const nextRevision = ++revisionNumber.current;
    refreshRequest.current = { revision: nextRevision, remaining: new Set(columns.map(column => column.id)) };
    setRefreshing(true); setRevision(nextRevision);
  };
  const reloadSeen = useRef(reloadToken);
  useEffect(() => {
    if (reloadSeen.current === reloadToken) return;
    reloadSeen.current = reloadToken;
    // A drop still in flight, or one whose outcome is unknown, keeps its own retry; it reloads when it settles.
    if (request.current || sending.current) return;
    refreshBoard();
    // refreshBoard reads the current columns; only a new token should trigger it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);
  const openSafely = (id: string, action?: QaCommand['type'], defaults?: QaActionDefaults) => {
    if (sending.current || request.current || refreshing) { toast.info(t('qa.finishPending'), { position: 'top-center' }); return; }
    onOpen(id, action, defaults);
  };
  const send = async () => {
    const pending = request.current;
    if (!pending || sending.current) return;
    sending.current = true; setBusy(true); setFailure(null);
    setMove({ issue: pending.issue, fromState: pending.issue.state, state: pending.command.state });
    const toastId = `qa-move-${pending.id}`;
    toast.loading(t('qa.dropSaving', { status: pending.label }), { id: toastId, position: 'top-center' });
    try {
      const updated = await client.command(pending.issue, pending.command, pending.id);
      request.current = null;
      toast.success(t('qa.dropSaved', { status: getQaStateLabel(workflow, updated.state, state => t(`qa.state.${state}`)) }), { id: toastId, duration: 4000, position: 'top-center' });
      if (mounted.current) {
        const nextRevision = ++revisionNumber.current;
        refreshRequest.current = { revision: nextRevision, remaining: new Set(columns.map(column => column.id)) };
        setMove({ issue: { ...pending.issue, ...updated }, fromState: pending.issue.state, state: updated.state, acknowledgedRevision: nextRevision });
        setRefreshing(true); setRevision(nextRevision);
      }
    } catch (error) {
      // Preserve the command ID after a lost response, so retry cannot duplicate the transition.
      const status = (error as { status?: number } | null)?.status;
      const uncertain = !status || status >= 500 || status === 408;
      if (!uncertain) request.current = null;
      if (mounted.current) { setMove(null); setFailure({ error, issue: pending.issue, uncertain }); }
      toast.error(t('qa.dropFailed'), { id: toastId, position: 'top-center', duration: uncertain ? Infinity : 10000,
        description: t(status === 403 ? 'qa.dropPermission' : status === 409 ? 'qa.conflict' : uncertain ? 'qa.dropUncertain' : 'qa.failed'),
        action: { label: t(uncertain ? 'qa.retry' : 'qa.openBug'), onClick: () => { if (uncertain && mounted.current) void send(); else if (!uncertain) openSafely(pending.issue.id); } } });
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const end = (event: DragEndEvent) => {
    setActive(null);
    const issue = event.active.data.current?.issue as QaIssue | undefined;
    const column = columns.find(item => `qa-column-${item.id}` === event.over?.id);
    if (!issue || !column) return;
    if (request.current || busy || refreshing) {
      toast.info(t(request.current && !sending.current ? 'qa.dropUncertain' : 'qa.saving'), { position: 'top-center' });
      return;
    }
    const intent = getQaDropIntent(issue, actor, column.states, column.id);
    if (intent.kind === 'blocked') {
      toast.error(t('qa.dropFailed'), { description: t(intent.reason === 'permission' ? 'qa.dropPermission' : 'qa.dropUnavailable'), position: 'top-center', duration: 10000,
        action: { label: t('qa.openBug'), onClick: () => openSafely(issue.id) } });
    } else if (intent.kind === 'command') {
      const command = intent.command, label = column.label;
      // Done and Won't fix by drag only change the status: no verification or reason is recorded.
      if (isQaTerminal(command.state)) {
        void confirm({ title: t('qa.terminalConfirmTitle', { status: label }), description: t('qa.terminalConfirmDesc') }).then(ok => {
          if (!ok || request.current || sending.current || !mounted.current) return;
          request.current = { issue, command, id: qaId(), label }; void send();
        });
        return;
      }
      request.current = { issue, command, id: qaId(), label }; void send();
    }
  };
  return <div className="min-w-0 space-y-3">
    <p className="text-xs text-muted-foreground">{t('qa.boardHint')}</p>
    {(busy || refreshing) && <p role="status" className="text-sm text-muted-foreground">{t(busy ? 'qa.saving' : 'qa.loading')}</p>}
    {failure && <div className="flex flex-wrap items-center gap-2"><QaFailure error={failure.error} />{failure.uncertain && <button className={qaButton} disabled={busy} onClick={() => void send()}>{t('qa.retry')}</button>}<button className={qaButton} disabled={busy} onClick={refreshBoard}>{t('qa.refresh')}</button>{!failure.uncertain && <button className={qaButton} disabled={busy} onClick={() => openSafely(failure.issue.id)}>{t('qa.openBug')}</button>}</div>}
    <DndContext sensors={sensors} collisionDetection={columnCollision} onDragStart={event => { setActive(event.active.data.current?.issue as QaIssue || null); }} onDragEnd={end} onDragCancel={() => setActive(null)}
      accessibility={{ screenReaderInstructions: { draggable: t('qa.dragInstructions') }, announcements: {
        onDragStart: ({ active: item }) => t('qa.dragPickedUp', { title: (item.data.current?.issue as QaIssue)?.title }),
        onDragOver: ({ over }) => over ? t('qa.dragOver', { status: columns.find(column => `qa-column-${column.id}` === over.id)?.label }) : t('qa.dragOutside'),
        onDragEnd: ({ over }) => over ? t('qa.dragDropped') : t('qa.dragCancelled'), onDragCancel: () => t('qa.dragCancelled'),
      } }}>
    <div className={`flex w-full min-w-0 min-h-[320px] items-stretch gap-3 overflow-x-auto overscroll-x-contain pb-4 ${active ? 'snap-none' : 'snap-x snap-proximity md:snap-none'}`}
      style={{ touchAction: 'pan-x pan-y', WebkitOverflowScrolling: 'touch' }} aria-label={t('qa.board')}>
      {columns.map(column => <QaColumn key={column.id} client={client} actor={actor} active={active} revision={revision} disabled={!!request.current || busy || refreshing} move={move} onLoaded={columnLoaded}
        state={column.id} states={column.shown} workflow={workflow} grouped={column.states.length > 1}
        label={column.label} filters={filters} onOpen={openSafely} />)}
    </div>
    <DragOverlay dropAnimation={null}>{active && <div aria-hidden="true" className="w-[280px] rounded-lg border border-border bg-card p-3 text-sm font-semibold shadow-xl">{active.title}</div>}</DragOverlay>
    </DndContext>
    {ConfirmDialog}
  </div>;
}

function QaColumn({ client, actor, state, states, workflow, grouped, label, filters, onOpen, active, revision, disabled, move, onLoaded }: {
  client: QaClient;
  actor: QaActor;
  state: QaState;
  states: QaState[];
  workflow: QaWorkflow;
  grouped: boolean;
  label: string;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type']) => void;
  active: QaIssue | null; revision: number; disabled: boolean;
  move: QaBoardMove | null; onLoaded: (state: QaState, revision: number) => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loadedRevision, setLoadedRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const attemptedOffset = useRef(0);
  const stateKey = states.join(',');
  const scopeKey = JSON.stringify({ ...filters, states: stateKey });
  const previousScope = useRef({ client, key: scopeKey });
  const load = useCallback(async (offset: number) => {
    pending.current?.abort();
    attemptedOffset.current = offset;
    const controller = new AbortController(); pending.current = controller;
    setLoading(true); setError(null);
    try {
      const page = await client.list({ ...filters, state: undefined, states: stateKey.split(',') as QaState[], offset, limit: 20 }, controller.signal);
      if (!controller.signal.aborted) {
        nextOffset.current = offset + page.issues.length;
        setResult(previous => ({ ...page, issues: offset ? [...previous.issues, ...page.issues.filter(issue => !previous.issues.some(old => old.id === issue.id))] : page.issues }));
        setLoadedRevision(revision);
        if (offset === 0) onLoaded(state, revision);
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [client, filters, stateKey, revision, onLoaded, state]);
  useEffect(() => {
    nextOffset.current = 0;
    if (previousScope.current.client !== client || previousScope.current.key !== scopeKey) {
      previousScope.current = { client, key: scopeKey }; setResult({ issues: [], total: 0, hasMore: false }); setLoadedRevision(0);
    }
    void load(0); return () => pending.current?.abort();
  }, [load, client, scopeKey]);
  // Keep the card in its destination until each refreshed page confirms the server result.
  const optimistic = move && (move.acknowledgedRevision === undefined || loadedRevision < move.acknowledgedRevision) ? move : null;
  const movedHere = !!optimistic && states.includes(optimistic.state), movedFrom = !!optimistic && states.includes(optimistic.fromState);
  const issues = optimistic ? [
    ...(movedHere ? [{ ...optimistic.issue, state: optimistic.state }] : []),
    ...result.issues.filter(issue => issue.id !== optimistic.issue.id),
  ] : result.issues;
  const total = Math.max(0, result.total + Number(movedHere) - Number(movedFrom));
  const { setNodeRef, isOver } = useDroppable({ id: `qa-column-${state}` });
  const blockedDrop = !!active && getQaDropIntent(active, actor, states, state).kind === 'blocked';
  return <section ref={setNodeRef} className={`flex min-h-[280px] w-[min(82vw,300px)] min-w-0 shrink-0 snap-start flex-col rounded-lg border bg-background transition-colors md:w-[280px] md:flex-1 md:min-w-[250px] ${isOver ? blockedDrop ? 'border-destructive bg-destructive/5' : 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border/80'}`} aria-label={label}>
    <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3"><h2 className="flex min-w-0 items-center gap-2 break-words text-sm font-semibold"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: qaStateColors[state] }} />{label}</h2><span className="rounded bg-background px-2 py-0.5 text-xs font-medium tabular-nums">{total}</span></header><div className="min-h-0 max-h-[max(240px,calc(100dvh-280px))] flex-1 space-y-3 overflow-y-auto overscroll-y-auto md:overscroll-y-contain p-2.5">
    {error !== null && <div className="mb-3 space-y-2"><QaFailure error={error} /><button className={qaButton} onClick={() => void load(attemptedOffset.current)}>{t('qa.refresh')}</button></div>}
    <ul className="space-y-2.5">{issues.map(issue => <QaDraggableCard key={issue.id} issue={issue} actor={actor} onOpen={onOpen} disabled={disabled}
      stateLabel={grouped ? getQaStateLabel(workflow,issue.state,state => t(`qa.state.${state}`)) : undefined} />)}</ul>
    {loading && <p role="status" className="py-4 text-center text-xs text-muted-foreground">{t('qa.loading')}</p>}
    {!loading && !error && !issues.length && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/80 px-3 py-10 text-center text-xs text-muted-foreground"><Inbox size={22} strokeWidth={1.5} aria-hidden="true" />{t('qa.boardEmpty')}</div>}
    {result.hasMore && <button className={`${qaButton} mt-3 w-full`} disabled={loading} onClick={() => void load(nextOffset.current)}>{t('qa.loadMore')}</button>}
    </div>
  </section>;
}

function QaDraggableCard({ issue, actor, onOpen, stateLabel, disabled }: { issue: QaIssue; actor: QaActor; onOpen: (id: string, action?: QaCommand['type']) => void; stateLabel?: string; disabled: boolean }) {
  const { t } = useTranslation();
  // Permission is explained visibly on drop; silently disabling drag looks like a broken board.
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: issue.id, data: { issue }, disabled });
  return <li ref={setNodeRef} {...attributes} {...listeners} data-drag-surface aria-label={issue.title} className={`select-none rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary ${isDragging ? 'opacity-30' : ''}`}
    style={{ touchAction: 'pan-x pan-y', WebkitTouchCallout: 'none' }}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter') { event.preventDefault(); onOpen(issue.id); } else listeners?.onKeyDown?.(event); }}>
    <QaIssueCard issue={issue} actor={actor} onOpen={onOpen} stateLabel={stateLabel} dragHandle={(
      <button {...attributes} {...listeners} type="button" data-drag-surface data-board-drag-handle
        aria-label={t('board.dragCard', { title: issue.title })}
        disabled={disabled}
        className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-card text-muted-foreground cursor-grab active:cursor-grabbing md:hidden [@media(any-pointer:coarse)]:inline-flex focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default disabled:opacity-50"
        style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
        onClick={event => { event.preventDefault(); event.stopPropagation(); }}>
        <GripVertical size={18} aria-hidden="true" />
      </button>
    )} />
  </li>;
}
