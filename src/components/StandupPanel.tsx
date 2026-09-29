import { useState, useCallback, useEffect, useRef } from 'react';
import { useUIContext } from '@/context/UIContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { useTaskContext } from '@/context/TaskContext';
import { useAuthContext } from '@/context/AuthContext';
import { useProjectContext } from '@/context/ProjectContext';
import { logActivity } from '@/lib/activityLog';
import { Play, Pause, RotateCcw, Zap, Trophy, SkipForward } from 'lucide-react';
import { useStandupSettings } from '@/hooks/useStandupSettings';
import { useStandupGrouping } from '@/hooks/useStandupGrouping';
import { useStandupTimer } from '@/hooks/useStandupTimer';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { SprintCompleteModal, SprintStartModal } from '@/components/board/SprintModals';
import type { PendingTaskAction } from '@/context/SprintContext';
import { StandupGroupHeader } from './standup/StandupGroupHeader';
import { StandupItemCard } from './standup/StandupItemCard';
import { useTranslation } from 'react-i18next';

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
  const { sprintActive, currentSprint, completeSprint, startSprint, getDefaultSprintName } = useSprintContext();
  const { allTasks, statuses } = useTaskContext();
  const { currentMemberId } = useAuthContext();
  const { allProjects } = useProjectContext();

  const [showSprintPrompt, setShowSprintPrompt] = useState(false);
  const [showCompleteModal, setShowCompleteModal] = useState(false);
  const [showStartModal, setShowStartModal]     = useState(false);
  const [carryOverTaskIds, setCarryOverTaskIds] = useState<string[]>([]);
  const [queueIndex, setQueueIndex]             = useState(0);
  const [standupFinished, setStandupFinished]   = useState(false);

  const sprintPromptRef = useFocusTrap(showSprintPrompt);

  const memberIds  = users.map(u => u.id);
  const sprintTasks = currentSprint
    ? allTasks.filter(t => t.sprintId === currentSprint.id)
    : allTasks;

  const { settings, getDurationForMember } = useStandupSettings(memberIds);
  const { groups, flatQueue } = useStandupGrouping(
    users, sprintTasks, allProjects,
    settings.sortMode, getDurationForMember, settings.bufferSeconds,
  );

  const currentItem    = flatQueue[queueIndex] ?? null;
  const currentDuration = currentItem
    ? getDurationForMember(currentItem.member.id)
    : settings.defaultSpeakDuration;

  const handleAdvance = useCallback(() => {
    const nextIdx = queueIndex + 1;
    if (nextIdx < flatQueue.length) {
      setQueueIndex(nextIdx);
      setStandupUserId(flatQueue[nextIdx].member.id);
    } else {
      // All members done — show completion screen
      setStandupFinished(true);
      setStandupUserId(null);
    }
  }, [queueIndex, flatQueue, setStandupUserId]);

  const { displayTime, inBuffer, isRunning, timerStatus, toggle, reset, skip } = useStandupTimer({
    duration: currentDuration,
    bufferSeconds: settings.bufferSeconds,
    autoAdvance: settings.autoAdvance,
    onAdvance: handleAdvance,
  });

  // Sync board filter with current speaker
  useEffect(() => {
    if (currentItem) setStandupUserId(currentItem.member.id);
  }, [currentItem?.member.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleExitStandup = useCallback(() => {
    if (sprintActive) setShowSprintPrompt(true);
    else {
      setStandupMode(false);
      if (currentMemberId) logActivity(currentMemberId, 'end_standup', `${t('activityLog.endStandup')}`, undefined, undefined, 'system');
    }
  }, [sprintActive, setStandupMode, currentMemberId, t]);

  // Keep a stable ref so the event listener always calls the latest version
  const handleExitStandupRef = useRef(handleExitStandup);
  useEffect(() => { handleExitStandupRef.current = handleExitStandup; }, [handleExitStandup]);

  // Listen for external exit event (from BoardHeader "退出" button)
  useEffect(() => {
    const handler = () => handleExitStandupRef.current();
    window.addEventListener('standup-exit', handler);
    return () => window.removeEventListener('standup-exit', handler);
  }, []);

  const handleSkipSprint = () => {
    setShowSprintPrompt(false);
    setStandupMode(false);
    if (currentMemberId) logActivity(currentMemberId, 'end_standup', `${t('activityLog.endStandup')}`, undefined, undefined, 'system');
  };

  const handleOpenCompleteModal = () => {
    setShowSprintPrompt(false);
    setShowCompleteModal(true);
  };

  const handleCompleteSprint = async (action: PendingTaskAction) => {
    setShowCompleteModal(false);
    const sprintName = currentSprint?.name || '';
    const pendingIds = await completeSprint(action);
    if (currentMemberId) {
      await logActivity(currentMemberId, 'complete_sprint', `${t('activityLog.completeSprint')}「${sprintName}」`, undefined, undefined, 'sprint');
    }
    setCarryOverTaskIds(pendingIds || []);
    setShowStartModal(true);
  };

  const handleConfirmStart = async (name: string, includeBacklog: boolean) => {
    setShowStartModal(false);
    await startSprint(name, carryOverTaskIds.length > 0 ? carryOverTaskIds : undefined, includeBacklog);
    setCarryOverTaskIds([]);
    if (currentMemberId) {
      await logActivity(currentMemberId, 'start_sprint', `${t('activityLog.startSprint')}「${name}」`, undefined, undefined, 'sprint');
    }
    setStandupMode(false);
  };

  const handleCancelStart = () => { setShowStartModal(false); setCarryOverTaskIds([]); setStandupMode(false); };

  // Escape key handler for sprint prompt
  useEffect(() => {
    if (!showSprintPrompt) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleSkipSprint(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showSprintPrompt]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sprint task stats
  const doneIds        = statuses.filter(s => s.isDone).map(s => s.id);
  const sprintTaskList = currentSprint ? allTasks.filter(t => t.sprintId === currentSprint.id) : [];
  const completedCount = sprintTaskList.filter(t => doneIds.includes(t.statusId)).length;
  const pendingTasks   = sprintTaskList.filter(t => !doneIds.includes(t.statusId));

  // Timer display values
  const minutes  = Math.floor(displayTime / 60);
  const seconds  = displayTime % 60;
  const maxTime  = inBuffer ? settings.bufferSeconds : currentDuration;
  const progress = maxTime > 0 ? (displayTime / maxTime) * 100 : 0;
  const strokeColor = TIMER_STROKE[timerStatus] ?? TIMER_STROKE.normal;
  const currentGroup = currentItem ? groups[currentItem.groupIndex] : null;

  const selectQueue = (idx: number) => {
    setQueueIndex(idx);
    setStandupUserId(flatQueue[idx]?.member.id ?? null);
    reset();
  };

  return (
    <>
      <div className="relative w-56 h-screen bg-sidebar flex flex-col flex-shrink-0">
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

        {/* Group header (hidden for by_member mode) */}
        {currentGroup && settings.sortMode !== 'by_member' && (
          <StandupGroupHeader
            groupTitle={currentGroup.group_title}
            groupIndex={currentItem?.groupIndex ?? 0}
            totalGroups={groups.length}
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
            {queueIndex + 1} / {flatQueue.length} {t('standup.memberCount')}
          </p>

          {/* Controls */}
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={toggle}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={isRunning ? t('button.pause') : t('button.play')}
              aria-label={isRunning ? t('button.pause') : t('button.play')}
            >
              {isRunning ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              onClick={() => reset()}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={t('common.reset')}
              aria-label={t('common.reset')}
            >
              <RotateCcw size={14} />
            </button>
            <button
              onClick={skip}
              className="p-1.5 rounded-full bg-sidebar-accent text-sidebar-primary-foreground hover:bg-sidebar-hover transition-colors"
              title={t('button.skipToNext')}
              aria-label={t('button.skipToNext')}
            >
              <SkipForward size={14} />
            </button>
          </div>
        </div>

        {/* Member list */}
        <div className="flex-1 overflow-y-auto px-2 space-y-0.5">
          {settings.sortMode === 'by_member'
            ? flatQueue.map((item, idx) => (
                <StandupItemCard
                  key={`${item.member.id}-${idx}`}
                  member={item.member}
                  active={idx === queueIndex}
                  onClick={() => selectQueue(idx)}
                />
              ))
            : groups.map((group, gi) => (
                <div key={group.group_key}>
                  <p className="px-2 pt-2 pb-0.5 text-[10px] font-semibold text-sidebar-foreground/40 uppercase tracking-wide truncate">
                    {group.group_title}
                  </p>
                  {group.members.map(member => {
                    const qIdx = flatQueue.findIndex(
                      q => q.member.id === member.id && q.groupIndex === gi,
                    );
                    return (
                      <StandupItemCard
                        key={`${member.id}-${gi}`}
                        member={member}
                        active={qIdx === queueIndex}
                        onClick={() => { if (qIdx >= 0) selectQueue(qIdx); }}
                      />
                    );
                  })}
                </div>
              ))
          }
        </div>

        {/* ── Standup finished overlay ─────────────────────────────────────── */}
        {standupFinished && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-sidebar z-10 px-4 text-center">
            <Trophy size={40} className="text-yellow-400 mb-3" />
            <p className="text-sm font-bold text-sidebar-primary-foreground">{t('standup.completion.title')}</p>
            <p className="text-xs text-sidebar-foreground/60 mt-1">
              {t('standup.completion.message', { count: flatQueue.length })}
            </p>
            <button
              onClick={() => { setStandupFinished(false); setQueueIndex(0); reset(); }}
              className="mt-4 text-xs text-sidebar-foreground/60 hover:text-sidebar-foreground underline transition-colors"
            >
              {t('button.backToList')}
            </button>
            <button
              onClick={handleExitStandup}
              className="mt-2 text-xs text-primary hover:text-primary/80 transition-colors"
            >
              {t('button.exitStandup')}
            </button>
          </div>
        )}
      </div>

      {/* ── Sprint completion prompt ─────────────────────────────────────── */}
      {showSprintPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleSkipSprint}>
          <div ref={sprintPromptRef} role="dialog" aria-modal="true" aria-labelledby="standup-sprint-complete-title" className="bg-card rounded-xl border border-border shadow-2xl p-6 max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
              <h2 id="standup-sprint-complete-title" className="text-base font-bold text-foreground mb-2 flex items-center gap-2">
                <Trophy size={18} className="text-yellow-500" />
                {t('sprint.prompt.title')}
              </h2>
              <p className="text-sm text-muted-foreground mb-4">{t('sprint.prompt.description')}</p>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={handleSkipSprint}
                  className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('button.skip')}
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
      {showCompleteModal && (
        <SprintCompleteModal
          currentSprint={currentSprint}
          completedCount={completedCount}
          pendingTasks={pendingTasks}
          onClose={() => { setShowCompleteModal(false); setStandupMode(false); }}
          onComplete={handleCompleteSprint}
        />
      )}

      {/* ── New Sprint start modal ──────────────────────────────────── */}
      {showStartModal && (
        <SprintStartModal
          defaultName={getDefaultSprintName()}
          onClose={handleCancelStart}
          onConfirm={handleConfirmStart}
          carryOverCount={carryOverTaskIds.length}
        />
      )}
    </>
  );
};

export default StandupPanel;