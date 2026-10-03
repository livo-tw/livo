import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Inbox } from 'lucide-react';
import { DndContext, DragOverlay, PointerSensor, TouchSensor, KeyboardSensor, useSensor, useSensors, useDraggable, useDroppable, closestCenter, pointerWithin, KeyboardCode, type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter } from '@dnd-kit/core';
import QaIssueCard from './QaIssueCard';
import { qaStateColors } from './QaBadges';
import type { QaActor, QaCommand, QaIssue, QaListInput, QaListResult, QaState } from '@/lib/qa/domain';
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

export default function QaKanban({ client, actor, workflow, filters, onOpen }: {
  client: QaClient;
  actor: QaActor;
  workflow: QaWorkflow;
  filters: QaListInput;
  onOpen: (id: string, action?: QaCommand['type'], defaults?: QaActionDefaults) => void;
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState<QaIssue | null>(null), [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(null), [blocked, setBlocked] = useState(false);
  const request = useRef<{ issue: QaIssue; command: Extract<QaCommand, { type: 'start_fix' }>; id: string } | null>(null);
  const mounted = useRef(true), sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const columns = getQaWorkflowColumns(workflow, state => t(`qa.state.${state}`)).filter(column => !filters.state || column.states.includes(filters.state));
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: columnCoordinates, keyboardCodes: { start: [KeyboardCode.Space], end: [KeyboardCode.Space], cancel: [KeyboardCode.Esc] } }));
  const send = async () => {
    const pending = request.current;
    if (!pending || sending.current) return;
    sending.current = true; setBusy(true); setError(null);
    try {
      await client.command(pending.issue, pending.command, pending.id);
      request.current = null;
      if (mounted.current) setRevision(value => value + 1);
    } catch (failure) {
      // Preserve the command ID after a lost response, so retry cannot duplicate the transition.
      if (mounted.current) setError(failure);
    } finally { sending.current = false; if (mounted.current) setBusy(false); }
  };
  const end = (event: DragEndEvent) => {
    setActive(null);
    const issue = event.active.data.current?.issue as QaIssue | undefined;
    const column = columns.find(item => `qa-column-${item.id}` === event.over?.id);
    if (!issue || !column || request.current) return;
    const intent = getQaDropIntent(issue, actor, column.states);
    setError(null); setBlocked(intent.kind === 'blocked');
    if (intent.kind === 'form') onOpen(issue.id, intent.action, { result: intent.result, resolution: intent.resolution });
    else if (intent.kind === 'command') { request.current = { issue, command: intent.command, id: qaId() }; void send(); }
  };
  return <div className="space-y-3">
    <p className="text-xs text-muted-foreground">{t('qa.boardHint')}</p>
    {busy && <p role="status" className="text-sm text-muted-foreground">{t('qa.saving')}</p>}
    {blocked && <p role="status" className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">{t('qa.dropUnavailable')}</p>}
    {error !== null && <div className="flex flex-wrap items-center gap-2"><QaFailure error={error} /><button className={qaButton} disabled={busy} onClick={() => void send()}>{t('qa.retry')}</button><button className={qaButton} disabled={busy} onClick={() => { request.current = null; setError(null); setRevision(value => value + 1); }}>{t('qa.refresh')}</button></div>}
    <DndContext sensors={sensors} collisionDetection={columnCollision} onDragStart={event => { setBlocked(false); setActive(event.active.data.current?.issue as QaIssue || null); }} onDragEnd={end} onDragCancel={() => setActive(null)}
      accessibility={{ screenReaderInstructions: { draggable: t('qa.dragInstructions') }, announcements: {
        onDragStart: ({ active: item }) => t('qa.dragPickedUp', { title: (item.data.current?.issue as QaIssue)?.title }),
        onDragOver: ({ over }) => over ? t('qa.dragOver', { status: columns.find(column => `qa-column-${column.id}` === over.id)?.label }) : t('qa.dragOutside'),
        onDragEnd: ({ over }) => over ? t('qa.dragDropped') : t('qa.dragCancelled'), onDragCancel: () => t('qa.dragCancelled'),
      } }}>
    <div className="flex min-h-[480px] items-stretch gap-3 overflow-x-auto pb-4 snap-x snap-proximity" aria-label={t('qa.board')}>
      {columns.map(column => <QaColumn key={column.id} client={client} actor={actor} active={active} revision={revision} disabled={!!request.current || busy}
        state={column.id} states={filters.state ? [filters.state] : column.states} workflow={workflow} grouped={column.states.length > 1}
        label={column.label} filters={filters} onOpen={onOpen} />)}
    </div>
    <DragOverlay dropAnimation={null}>{active && <div aria-hidden="true" className="w-[280px] rounded-lg border border-border bg-card p-3 text-sm font-semibold shadow-xl">{active.title}</div>}</DragOverlay>
    </DndContext>
  </div>;
}

function QaColumn({ client, actor, state, states, workflow, grouped, label, filters, onOpen, active, revision, disabled }: {
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
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<QaListResult>({ issues: [], total: 0, hasMore: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const pending = useRef<AbortController | null>(null);
  const nextOffset = useRef(0);
  const attemptedOffset = useRef(0);
  const stateKey = states.join(',');
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
      }
    } catch (failure) { if (!controller.signal.aborted) setError(failure); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }, [client, filters, stateKey]);
  useEffect(() => { nextOffset.current = 0; setResult({ issues: [], total: 0, hasMore: false }); void load(0); return () => pending.current?.abort(); }, [load, revision]);
  const { setNodeRef, isOver } = useDroppable({ id: `qa-column-${state}` });
  const blockedDrop = !!active && getQaDropIntent(active, actor, states).kind === 'blocked';
  return <section ref={setNodeRef} className={`flex min-h-[320px] w-[min(82vw,280px)] min-w-[250px] flex-1 shrink-0 snap-start flex-col rounded-lg border bg-background transition-colors ${isOver ? blockedDrop ? 'border-destructive bg-destructive/5' : 'border-primary bg-primary/5 ring-1 ring-primary/30' : 'border-border/80'}`} aria-label={label}>
    <header className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-3"><h2 className="flex min-w-0 items-center gap-2 break-words text-sm font-semibold"><span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: qaStateColors[state] }} />{label}</h2><span className="rounded bg-background px-2 py-0.5 text-xs font-medium tabular-nums">{result.total}</span></header><div className="min-h-0 max-h-[calc(100dvh-310px)] flex-1 space-y-3 overflow-y-auto overscroll-contain p-2.5">
    {error !== null && <div className="mb-3 space-y-2"><QaFailure error={error} /><button className={qaButton} onClick={() => void load(attemptedOffset.current)}>{t('qa.refresh')}</button></div>}
    <ul className="space-y-2.5">{result.issues.map(issue => <QaDraggableCard key={issue.id} issue={issue} actor={actor} onOpen={onOpen} disabled={disabled}
      stateLabel={grouped ? getQaStateLabel(workflow,issue.state,state => t(`qa.state.${state}`)) : undefined} />)}</ul>
    {loading && <p role="status" className="py-4 text-center text-xs text-muted-foreground">{t('qa.loading')}</p>}
    {!loading && !error && !result.issues.length && <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border/80 px-3 py-10 text-center text-xs text-muted-foreground"><Inbox size={22} strokeWidth={1.5} aria-hidden="true" />{t('qa.boardEmpty')}</div>}
    {result.hasMore && <button className={`${qaButton} mt-3 w-full`} disabled={loading} onClick={() => void load(nextOffset.current)}>{t('qa.loadMore')}</button>}
    </div>
  </section>;
}

function QaDraggableCard({ issue, actor, onOpen, stateLabel, disabled }: { issue: QaIssue; actor: QaActor; onOpen: (id: string, action?: QaCommand['type']) => void; stateLabel?: string; disabled: boolean }) {
  const movable = ['new', 'triaged', 'in_progress', 'verification', 'verified', 'failed', 'closed', 'dismissed'].some(state => {
    const intent = getQaDropIntent(issue, actor, [state as QaState]); return intent.kind === 'form' || intent.kind === 'command';
  });
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: issue.id, data: { issue }, disabled: disabled || !movable });
  return <li ref={setNodeRef} {...attributes} {...listeners} aria-label={issue.title} className={`rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-primary ${isDragging ? 'opacity-30' : ''}`}
    onKeyDown={event => { if (event.target !== event.currentTarget) return; if (event.key === 'Enter') { event.preventDefault(); onOpen(issue.id); } else listeners?.onKeyDown?.(event); }}>
    <QaIssueCard issue={issue} actor={actor} onOpen={onOpen} stateLabel={stateLabel} />
  </li>;
}
