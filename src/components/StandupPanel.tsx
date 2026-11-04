import { sprintSummary } from '@/lib/sprintLifecycle';
import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { sprintBacklogTaskIds } from '@/lib/sprintBacklog';
import { useUIContext } from '@/context/UIContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { logActivity } from '@/lib/activityLog';
import { Play, Pause, RotateCcw, Trophy, SkipForward, UserMinus } from 'lucide-react';
import { useStandupSettings } from '@/hooks/useStandupSettings';
import { useStandupGrouping } from '@/hooks/useStandupGrouping';
import { useStandupTimer } from '@/hooks/useStandupTimer';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import { useSprintFlow } from '@/hooks/useSprintFlow';
import { StandupGroupHeader } from './standup/StandupGroupHeader';
import { StandupItemCard } from './standup/StandupItemCard';
import { StandupQueueEditor } from './standup/StandupQueueEditor';
import { useStandupQueue } from '@/hooks/useStandupQueue';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { clearStandupLaunch, getStandupLaunch, standupQueueKey, type StandupLaunchSnapshot } from '@/lib/standupLaunch';

const TIMER_STROKE: Record<string, string> = {
  idle:     'hsl(var(--sidebar-active))',
  normal:   'hsl(var(--sidebar-active))',
  warning:  '#f59e0b',
  critical: 'hsl(var(--destructive))',
  buffer:   'hsl(var(--primary))',
};

const StandupPanel = () => {
  const { t } = useTranslation();
  const { setStandupUserId, setStandupMode } = useUIContext();
  const { users } = useMemberContext();
  const { sprintActive, currentSprint, getDefaultSprintName } = useSprintContext();
  const { allTasks, statuses } = useTaskContext();
  const { currentMemberId } = useAuthContext();
  const { allProjects, setSelectedProjectId } = useProjectContext();

  const [showSprintPrompt, setShowSprintPrompt] = useState(false);
  const [launch] = useState(getStandupLaunch);
  const fullLaunch = useMemo<StandupLaunchSnapshot | undefined>(() => launch ? { ...launch, excludedMemberIds: [] } : undefined, [launch]);

  const sprintPromptRef = useFocusTrap(showSprintPrompt);

  const memberIds = users.filter(user => user.isActive === true).map(u => u.id);
  const sprintTasks = currentSprint
    ? allTasks.filter(t => t.sprintId === currentSprint.id)
    : allTasks;

  const { settings, getDurationForMember } = useStandupSettings(memberIds, { initial: launch?.settings });
  const { groups } = useStandupGrouping(
    users, sprintTasks, allProjects,
    settings.sortMode, getDurationForMember, settings.bufferSeconds, fullLaunch, settings.includeReviewTasks !== false,
  );
  const queue = useStandupQueue(groups, launch?.excludedMemberIds);
  const restoreMemberRef = useRef(queue.restoreMember);
  restoreMemberRef.current = memberId => {
    queue.restoreMember(memberId);
    setShowSprintPrompt(false);
  };
  const { currentItem, currentKey, flatQueue, queueIndex, finished: standupFinished } = queue;
  const currentDuration = currentItem
    ? getDurationForMember(currentItem.member.id)
    : settings.defaultSpeakDuration;

  const startOnTurnRef = useRef<string | null>(null);
  const focusTurnRef = useRef<string | null>(null);
  const currentRowRef = useRef<HTMLDivElement>(null);

  function handleAdvance() {
    if (!currentKey) return;
    const nextKey = queue.advance();
    startOnTurnRef.current = hasStarted ? nextKey : null;
    if (!nextKey && sprintActive) setShowSprintPrompt(true);
  }

  const { displayTime, maxTime, inBuffer, isRunning, hasStarted, timerStatus, pause, resume, reset } = useStandupTimer({
    turnKey: currentKey,
    startOnTurn: currentKey !== null && currentKey === startOnTurnRef.current,
    duration: currentDuration,
    bufferSeconds: settings.bufferSeconds,
    autoAdvance: settings.autoAdvance,
    onAdvance: handleAdvance,
  });

  const selectTurn = (groupKey: string, memberId: string, reportAgain = false) => {
    const key = queue.select(groupKey, memberId, hasStarted, reportAgain);
    if (!key) return;
    startOnTurnRef.current = key;
    focusTurnRef.current = key;
    setShowSprintPrompt(false);
  };

  const reportProjectId = !standupFinished && settings.sortMode === 'by_project'
    && currentItem?.group.group_key !== '__unassigned__' ? currentItem?.group.group_key ?? null : null;
  useEffect(() => {
    setStandupUserId(standupFinished ? null : currentItem?.member.id ?? null);
    setSelectedProjectId(reportProjectId);
  }, [currentKey, currentItem?.member.id, standupFinished, reportProjectId, setStandupUserId, setSelectedProjectId]);

  useEffect(() => {
    if (currentKey && focusTurnRef.current === currentKey) {
      currentRowRef.current?.querySelector<HTMLButtonElement>('button[aria-current="step"]')?.focus({ preventScroll: true });
    }
    startOnTurnRef.current = null;
    focusTurnRef.current = null;
  }, [currentKey]);

  const leaveStandup = useCallback(() => {
    clearStandupLaunch();
    setStandupUserId(null);
    setSelectedProjectId(null);
    setStandupMode(false);
  }, [setStandupUserId, setSelectedProjectId, setStandupMode]);
  // The stand-up ends with completing the sprint and offering to start the next one.
  const sprintFlow = useSprintFlow({ startAfterComplete: 'always', onStarted: leaveStandup, onStartClosed: leaveStandup });

  const handleExitStandup = useCallback(() => {
    leaveStandup();
    if (currentMemberId) logActivity(currentMemberId, 'end_standup', `${t('activityLog.endStandup')}`, undefined, undefined, 'system');
  }, [leaveStandup, currentMemberId, t]);

  // Keep a stable ref so the event listener always calls the latest version
  const handleExitStandupRef = useRef(handleExitStandup);
  useEffect(() => { handleExitStandupRef.current = handleExitStandup; }, [handleExitStandup]);

  // Listen for external exit event (from BoardHeader "退出" button)
  useEffect(() => {
    const handler = () => handleExitStandupRef.current();
    window.addEventListener('standup-exit', handler);
    return () => window.removeEventListener('standup-exit', handler);
  }, []);

  const dismissSprintPrompt = useCallback(() => setShowSprintPrompt(false), []);

  const handleOpenCompleteModal = () => {
    setShowSprintPrompt(false);
    sprintFlow.openComplete();
  };

  // Escape key handler for sprint prompt
  useEffect(() => {
    if (!showSprintPrompt) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') dismissSprintPrompt(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSprintPrompt, dismissSprintPrompt]);

  // Sprint task stats
  const doneIds        = statuses.filter(s => s.isDone).map(s => s.id);
  const sprintTaskList = currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id) : [];
  const completedCount = sprintSummary(sprintTaskList, statuses).completed.length;
  const cancelledCount = sprintSummary(sprintTaskList, statuses).cancelled.length;
  const pendingTasks   = sprintTaskList.filter(t => !doneIds.includes(t.statusId));

  // Timer display values
  const minutes  = Math.floor(displayTime / 60);
  const seconds  = displayTime % 60;
  const progress = maxTime > 0 ? (displayTime / maxTime) * 100 : 0;
  const strokeColor = TIMER_STROKE[timerStatus] ?? TIMER_STROKE.normal;
  const currentGroup = currentItem?.group ?? null;
  const scheduledGroups = [...new Set(flatQueue.map(item => item.group.group_key))];
  const excludeMember = (memberId: string) => {
    queue.excludeMember(memberId);
    const member = users.find(user => user.id === memberId);
    toast(t('standup.queue.excludedNotice', { name: member?.name ?? '' }), {
      action: { label: t('standup.queue.undo'), onClick: () => restoreMemberRef.current(memberId) },
    });
  };
  const skipCurrent = () => {
    if (!currentItem) return;
    const { id, name } = currentItem.member;
    queue.skipCurrent();
    toast(t('standup.queue.excludedNotice', { name }), {
      action: { label: t('standup.queue.undo'), onClick: () => restoreMemberRef.current(id) },
    });
  };

  return (
    <>
      <div className="relative w-72 max-w-full h-full min-h-0 bg-sidebar flex flex-col flex-shrink-0">
        {/* Top bar */}
        <div className="px-4 py-2 flex items-center justify-between flex-shrink-0">
          <span className="text-xs font-bold text-sidebar-primary-foreground">{t('standup.mode')}</span>
          <button
            onClick={handleExitStandup}
            className="text-[10px] text-sidebar-foreground/60 hover:text-sidebar-foreground transition-colors"
          >
            {t('button.exit')}
          </button>
        </div>

        {standupFinished && (
          <div role="status" className="flex flex-shrink-0 items-center gap-2 px-4 py-3">
            <Trophy size={20} className="shrink-0 text-yellow-400" aria-hidden="true" />
            <div>
              <p className="text-sm font-bold text-sidebar-primary-foreground">{t('standup.completion.title')}</p>
              <p className="text-xs text-sidebar-foreground/60">
                {t('standup.completion.message', { count: new Set(queue.completedQueue.map(item => item.member.id)).size })}
              </p>
            </div>
          </div>
        )}

        {!standupFinished && <>
        {/* Group header (hidden for by_member mode) */}
        {currentGroup && settings.sortMode !== 'by_member' && (
          <StandupGroupHeader
            groupTitle={currentGroup.group_title}
            groupIndex={scheduledGroups.indexOf(currentGroup.group_key)}
            totalGroups={scheduledGroups.length}
            taskCount={currentGroup.task_count}
          />
        )}

        {/* Timer circle */}
        <div className="px-4 py-3 text-center flex-shrink-0">
          <div className="relative w-24 h-24 mx-auto mb-1">
            <svg className="transform -rotate-90 w-24 h-24" aria-hidden="true">
              <circle cx="48" cy="48" r="42" fill="none" stroke="hsl(var(--sidebar-accent))" strokeWidth="4" />
              <circle
                cx="48" cy="48" r="42" fill="none"
                stroke={strokeColor}
                strokeWidth="4"
                strokeDasharray={`${2 * Math.PI * 42}`}
                strokeDashoffset={`${2 * Math.PI * 42 * (1 - progress / 100)}`}
                strokeLinecap="round"
                className={timerStatus === 'critical' ? 'animate-pulse' : ''}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="text-lg font-mono font-bold text-sidebar-primary-foreground">
                {minutes}:{seconds.toString().padStart(2, '0')}
              </span>
              {inBuffer && (
                <span className="text-[9px] text-sidebar-foreground/60 leading-none">{t('standup.buffer')}</span>
              )}
            </div>
          </div>

          {/* Progress indicator */}
          <p className="text-[10px] text-sidebar-foreground/50 mb-2">
            {currentItem ? queueIndex + 1 : queue.completedQueue.length} / {flatQueue.length} {t(settings.sortMode === 'by_project' ? 'standup.turnUnit' : 'standup.memberCount')}
          </p>

          {/* Controls */}
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={isRunning ? pause : resume}
              disabled={!currentItem || standupFinished}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={isRunning ? t('button.pause') : t('button.play')}
              aria-label={isRunning ? t('button.pause') : t('button.play')}
            >
              {isRunning ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={() => reset()}
              disabled={!currentItem || standupFinished}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={t('common.reset')}
              aria-label={t('common.reset')}
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={handleAdvance}
              disabled={!currentItem || standupFinished}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={t('button.skipToNext')}
              aria-label={t('button.skipToNext')}
            >
              <SkipForward size={14} />
            </button>
          </div>
        </div>

        </>}

        {/* Member list */}
        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-3">
          {!flatQueue.length && <p role="status" className="px-2 py-3 text-xs text-sidebar-foreground/60">{t(groups.length ? 'standup.queue.noPending' : 'standup.noActiveMembers')}</p>}
          {currentItem && <section>
            <p className="px-2 pb-1 text-xs font-medium text-sidebar-foreground/60">{t('standup.queue.current')}</p>
            <div ref={currentRowRef} className="flex items-center rounded bg-sidebar-active">
              <div className="min-w-0 flex-1"><StandupItemCard member={currentItem.member} active onClick={resume} /></div>
              <button type="button" onClick={skipCurrent} title={t('standup.queue.skipCurrent')} aria-label={t('standup.queue.skipCurrent')}
                className="inline-flex min-h-11 min-w-9 shrink-0 items-center justify-center rounded text-sidebar-primary-foreground hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-primary">
                <UserMinus size={14} aria-hidden="true" />
              </button>
            </div>
          </section>}
          <section>
            <p className="px-2 pb-1 text-xs font-medium text-sidebar-foreground/60">{t('standup.queue.pending')}</p>
            <StandupQueueEditor groups={queue.pendingGroups} sortMode={settings.sortMode}
              onReorder={queue.reorderPending} excludedMembers={queue.excludedMembers}
              onExclude={excludeMember} onRestore={restoreMemberRef.current} onSelect={selectTurn}
              compact label={t('standup.queue.pending')} />
          </section>
          {queue.completedQueue.length > 0 && <details open className="text-sidebar-foreground/60">
            <summary className="min-h-9 cursor-pointer px-2 py-2 text-xs">{t('standup.queue.completed')} ({queue.completedQueue.length})</summary>
            {queue.completedQueue.map(item => {
              const name = t('standup.queue.reportAgainNamed', { name: item.member.name });
              const label = settings.sortMode === 'by_member' ? name : `${name} · ${item.group.group_title}`;
              return <div key={standupQueueKey(item)} className="flex min-w-0 items-center gap-2 rounded px-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {item.member.name}{settings.sortMode !== 'by_member' && <span className="ml-1 opacity-70">· {item.group.group_title}</span>}
                </span>
                <button type="button" aria-label={label} title={label} onClick={() => selectTurn(item.group.group_key, item.member.id, true)}
                  className="min-h-9 shrink-0 rounded px-2 font-medium text-sidebar-primary-foreground hover:bg-sidebar-hover focus-visible:ring-2 focus-visible:ring-primary">
                  {t('standup.queue.reportAgain')}
                </button>
              </div>;
            })}
          </details>}
        </div>

      </div>

      {/* ── Sprint completion prompt ─────────────────────────────────────── */}
      {showSprintPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={dismissSprintPrompt}>
          <div ref={sprintPromptRef} role="dialog" aria-modal="true" aria-labelledby="standup-sprint-complete-title" className="bg-card rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
              <h2 id="standup-sprint-complete-title" className="text-base font-bold text-foreground mb-2 flex items-center gap-2">
                <Trophy size={18} className="text-yellow-500" />
                {t('sprint.prompt.title')}
              </h2>
              <p className="text-sm text-muted-foreground mb-4">{t('sprint.prompt.description')}</p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={dismissSprintPrompt}
                  className="min-h-11 rounded px-3 py-1.5 text-sm text-foreground hover:bg-accent focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {t('button.backToList')}
                </button>
                <button
                  onClick={handleExitStandup}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('button.exitStandup')}
                </button>
                <button
                  onClick={handleOpenCompleteModal}
                  className="px-3 py-1.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors"
                >
                  {t('sprint.prompt.endSprint')}
                </button>
              </div>
            </div>
          </div>
        )}

      {/* ── Sprint complete modal with pending task options ──── */}
      {sprintFlow.showCompleteModal && (
        <SprintCompleteModal
          currentSprint={currentSprint}
          completedCount={completedCount}
          pendingTasks={pendingTasks}
          cancelledCount={cancelledCount}
          busy={sprintFlow.busy}
          retryOnly={sprintFlow.retryOnly}
          onClose={() => { sprintFlow.closeComplete(); leaveStandup(); }}
          onComplete={action => void sprintFlow.complete(action)}
        />
      )}

      {/* ── New Sprint start modal ──────────────────────────────────── */}
      {sprintFlow.showStartModal && (
        <SprintStartModal
          busy={sprintFlow.busy}
          retryOnly={sprintFlow.retryOnly}
          defaultName={getDefaultSprintName()}
          onClose={sprintFlow.cancelStart}
          onConfirm={(name, includeBacklog) => void sprintFlow.confirmStart(name, includeBacklog)}
          carryOverCount={sprintFlow.carryOverTaskIds.length}
          excludedCarryCount={sprintFlow.skippedCarryCount}
          backlogCount={sprintBacklogTaskIds(allTasks, statuses, allProjects, sprintFlow.carryOverTaskIds).length}
        />
      )}
    </>
  );
};

export default StandupPanel;
