import { SearchableSelect } from '@/components/ui/searchable-select';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@/i18n';
import { X, ChevronDown, ChevronUp, Shuffle } from 'lucide-react';
import { useMemberContext } from '@/context/MemberContext';
import { useTaskContext } from '@/context/TaskContext';
import { useSprintContext } from '@/context/SprintContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useStandupSettings, type SortMode } from '@/hooks/useStandupSettings';
import { useStandupGrouping } from '@/hooks/useStandupGrouping';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { StandupQueueEditor } from './standup/StandupQueueEditor';
import type { StandupGroup } from '@/hooks/useStandupGrouping';
import { applyStandupOrder, restoreStandupGroups, saveStandupLaunch, shuffleStandupOrder, standupOrderFromGroups, type StandupOrder } from '@/lib/standupLaunch';

export interface StandupLaunchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm?: () => void;
  onCancel?: () => void;
}

const DURATION_OPTIONS = Array.from({ length: 20 }, (_, i) => (i + 1) * 30); // 30 s … 600 s

function formatDuration(seconds: number): string {
  if (seconds < 60) return i18n.t('standup.secondsFormat', { seconds });
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? i18n.t('standup.minutesFormat', { minutes: m }) : i18n.t('standup.minutesSecondsFormat', { minutes: m, seconds: s });
}

const SORT_MODES: { value: SortMode; labelKey: string }[] = [
  { value: 'by_member',     labelKey: 'standup.sortMode.byMember' },
  { value: 'by_project',    labelKey: 'standup.sortMode.byProject' },
  { value: 'by_due_date',   labelKey: 'standup.sortMode.byDueDate' },
  { value: 'by_department', labelKey: 'standup.sortMode.byDepartment' },
];

const StandupLaunchDialog = ({ open, onOpenChange, onConfirm, onCancel }: StandupLaunchDialogProps) => {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const { allTasks } = useTaskContext();
  const { currentSprint } = useSprintContext();
  const { allProjects } = useProjectContext();
  const [showOverrides, setShowOverrides] = useState(false);
  const [order, setOrder] = useState<StandupOrder>();
  const [orderSource, setOrderSource] = useState<'manual' | 'shuffle'>();
  const [excludedMemberIds, setExcludedMemberIds] = useState<string[]>([]);
  const [lastExclusion, setLastExclusion] = useState<{ memberId: string; name: string; ids: string[]; order?: StandupOrder; source?: 'manual' | 'shuffle' }>();
  useEffect(() => {
    if (!open) return;
    setOrder(undefined);
    setOrderSource(undefined);
    setExcludedMemberIds([]);
    setLastExclusion(undefined);
  }, [open]);

  const activeUsers = users.filter(user => user.isActive === true);
  const memberIds = activeUsers.map(u => u.id);
  const {
    settings,
    updateSettings,
    keepCurrentSettings,
    setMemberDuration,
    resetMemberDuration,
    getDurationForMember,
  } = useStandupSettings(memberIds, { active: open });

  const sprintTasks = currentSprint
    ? allTasks.filter(t => t.sprintId === currentSprint.id)
    : allTasks;

  const { groups: sortedGroups } = useStandupGrouping(
    activeUsers, sprintTasks, allProjects,
    settings.sortMode, getDurationForMember, settings.bufferSeconds,
  );
  const fullGroups = applyStandupOrder(sortedGroups, order);
  const groups = excludedMemberIds.length ? restoreStandupGroups({
    settings,
    groups: fullGroups.map(({ members, ...group }) => ({ ...group, memberIds: members.map(member => member.id) })),
    excludedMemberIds,
  }, activeUsers, sprintTasks, getDurationForMember, settings.bufferSeconds) : fullGroups;
  const excludedMembers = activeUsers.filter(user => excludedMemberIds.includes(user.id));
  const reportTurns = groups.reduce((sum, group) => sum + group.members.length, 0);
  const participantCount = new Set(groups.flatMap(group => group.members.map(member => member.id))).size;

  const totalSec = groups.reduce((sum, group) => sum + group.estimated_duration, 0);
  const totalMins = Math.round(totalSec / 60);

  // The editor works on eligible reports; keep hidden members in the launch roster
  // so every exclusion can be recovered, including repeated project reports.
  const applyEligibleOrder = (nextGroups: StandupGroup[], source: 'manual' | 'shuffle') => {
    keepCurrentSettings();
    setOrder(standupOrderFromGroups(applyStandupOrder(fullGroups, standupOrderFromGroups(nextGroups))));
    setOrderSource(source);
    setLastExclusion(undefined);
  };
  const excludeMember = (memberId: string) => {
    const member = activeUsers.find(user => user.id === memberId);
    if (!member || excludedMemberIds.includes(memberId)) return;
    setLastExclusion({ memberId, name: member.name, ids: excludedMemberIds, order, source: orderSource });
    setExcludedMemberIds(ids => [...ids, memberId]);
  };
  const restoreMember = (memberId: string) => {
    if (!excludedMemberIds.includes(memberId)) return;
    keepCurrentSettings();
    const previouslyHiddenGroups = new Set(fullGroups.filter(group => group.members.every(member => excludedMemberIds.includes(member.id))).map(group => group.group_key));
    const restored = fullGroups.map(group => ({ ...group, members: [
      ...group.members.filter(member => member.id !== memberId),
      ...group.members.filter(member => member.id === memberId),
    ] }));
    const appendGroups = new Set(restored.filter(group => group.members.some(member => member.id === memberId) &&
      (settings.sortMode === 'by_member' || previouslyHiddenGroups.has(group.group_key))).map(group => group.group_key));
    setOrder(standupOrderFromGroups([...restored.filter(group => !appendGroups.has(group.group_key)), ...restored.filter(group => appendGroups.has(group.group_key))]));
    setOrderSource('manual');
    setExcludedMemberIds(ids => ids.filter(id => id !== memberId));
    setLastExclusion(undefined);
  };
  const resetOrder = () => { setOrder(undefined); setOrderSource(undefined); setLastExclusion(undefined); };

  const handleCancel = () => { onCancel?.(); onOpenChange(false); };
  const cancelRef = useRef(handleCancel); cancelRef.current = handleCancel;
  const focus = useFocusTrap(open);
  const undoFocusRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const memberId = undoFocusRef.current;
    if (!memberId) return;
    const handle = Array.from(focus.current?.querySelectorAll<HTMLButtonElement>('button[data-standup-report-id]') ?? [])
      .find(button => button.getAttribute('data-standup-report-id') === memberId);
    (handle ?? focus.current?.querySelector<HTMLButtonElement>('button:not([disabled])'))?.focus();
    undoFocusRef.current = null;
  }, [excludedMemberIds, focus]);
  // Esc closes it like the other dialogs, unless a dropdown inside is open (it closes first).
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      if ((event.target as HTMLElement | null)?.closest?.('[data-radix-popper-content-wrapper], [role="listbox"]')) return;
      // The dialog listener predates dnd-kit's sensor listener. Let the sensor
      // cancel an active drag before a later Escape can close the dialog.
      if (focus.current?.querySelector('[data-standup-dragging="true"]')) return;
      cancelRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  const handleConfirm = () => { if (!groups.length) return; saveStandupLaunch(settings, fullGroups, excludedMemberIds); onConfirm?.(); onOpenChange(false); };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={handleCancel}>
      <div
        ref={focus}
        role="dialog" aria-modal="true" aria-labelledby="standup-launch-title"
        className="bg-card rounded-xl shadow-xl border border-border w-full max-w-lg max-h-[90vh] overflow-hidden flex flex-col mx-3"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
          <h2 id="standup-launch-title" className="text-base font-bold text-foreground">{t('standup.settings.title')}</h2>
          <button aria-label={t('common.cancel')} onClick={handleCancel} className="text-muted-foreground hover:text-foreground">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="overflow-y-auto flex-1 px-6 py-4 space-y-5">

          {/* Sort mode */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">{t('standup.settings.sortMode')}</label>
            <div className="flex gap-2 flex-wrap">
              {SORT_MODES.map(m => (
                <button
                  key={m.value}
                  onClick={() => { resetOrder(); updateSettings({ sortMode: m.value }); }}
                  aria-pressed={settings.sortMode === m.value}
                  className={`px-3 py-1.5 rounded text-xs font-medium border transition-colors ${
                    settings.sortMode === m.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'border-border text-foreground hover:bg-accent'
                  }`}
                >
                  {t(m.labelKey)}
                </button>
              ))}
              <button type="button" disabled={reportTurns < 2} aria-pressed={orderSource === 'shuffle'}
                onClick={() => applyEligibleOrder(applyStandupOrder(groups, shuffleStandupOrder(groups)), 'shuffle')}
                className="inline-flex items-center gap-1.5 rounded border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50">
                <Shuffle size={13} aria-hidden="true" />{t('standup.settings.shuffle')}
              </button>
            </div>
          </div>

          {/* Default duration */}
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-2 block">{t('standup.settings.defaultDuration')}</label>
            <SearchableSelect
              value={settings.defaultSpeakDuration}
              aria-label={t('standup.settings.defaultDuration')}
              onChange={e => updateSettings({ defaultSpeakDuration: Number(e.target.value) })}
              className="w-full border border-border rounded px-3 py-2 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary"
            >
              {DURATION_OPTIONS.map(v => (
                <option key={v} value={v}>{formatDuration(v)}</option>
              ))}
            </SearchableSelect>
          </div>

          {/* Auto-advance toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-foreground">{t('standup.settings.autoAdvance')}</p>
              <p className="text-xs text-muted-foreground">{t('standup.settings.autoAdvanceDesc', { seconds: settings.bufferSeconds })}</p>
            </div>
            <button
              role="switch"
              aria-checked={settings.autoAdvance}
              onClick={() => updateSettings({ autoAdvance: !settings.autoAdvance })}
              className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${
                settings.autoAdvance ? 'bg-primary' : 'bg-muted'
              }`}
              aria-label={t('standup.settings.autoAdvance')}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  settings.autoAdvance ? 'left-5' : 'left-0.5'
                }`}
              />
            </button>
          </div>

          {/* Per-member overrides */}
          <div>
            <button
              className="flex items-center gap-1 text-xs font-medium text-muted-foreground hover:text-foreground"
              onClick={() => setShowOverrides(v => !v)}
            >
              {t('standup.settings.memberOverrides')}
              {showOverrides ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {showOverrides && (
              <div className="mt-2 space-y-1.5 border border-border rounded-md p-3 bg-accent/20">
                {activeUsers.map(user => {
                  const custom = settings.memberDurations[user.id];
                  return (
                    <div key={user.id} className="flex items-center gap-2">
                      <div
                        className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold flex-shrink-0"
                        style={{ backgroundColor: user.color, color: '#fff' }}
                      >
                        {user.avatar}
                      </div>
                      <span className="text-xs flex-1 text-foreground truncate">{user.name}</span>
                      <SearchableSelect
                        value={custom ?? settings.defaultSpeakDuration}
                        aria-label={`${user.name} · ${t('standup.settings.memberOverrides')}`}
                        onChange={e => setMemberDuration(user.id, Number(e.target.value))}
                        className={`border rounded px-1.5 py-0.5 text-xs bg-card text-foreground outline-none focus:ring-1 focus:ring-primary ${
                          custom ? 'border-primary' : 'border-border'
                        }`}
                      >
                        {DURATION_OPTIONS.map(v => (
                          <option key={v} value={v}>{formatDuration(v)}</option>
                        ))}
                      </SearchableSelect>
                      {custom && (
                        <button
                          onClick={() => resetMemberDuration(user.id)}
                          className="text-[10px] text-muted-foreground hover:text-destructive whitespace-nowrap"
                        >
                          {t('common.reset')}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Editable report order and meeting-local exclusions */}
          {fullGroups.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">{t('standup.settings.preview')}</p>
                {orderSource === 'manual' && <div className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">{t('standup.queue.manual')}</span>
                  <button type="button" onClick={resetOrder} className="text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">{t('standup.queue.reset')}</button>
                </div>}
              </div>
              <p className="text-xs text-muted-foreground" role="status">{t('standup.queue.summary', { count: participantCount, excluded: excludedMembers.length, turns: reportTurns })}</p>
              <StandupQueueEditor
                groups={groups}
                sortMode={settings.sortMode}
                onReorder={nextGroups => applyEligibleOrder(nextGroups, 'manual')}
                excludedMembers={excludedMembers}
                onExclude={excludeMember}
                onRestore={restoreMember}
                label={t('standup.settings.preview')}
              />
              {lastExclusion && <div role="status" className="flex items-center justify-between gap-2 rounded border border-border bg-accent/30 px-3 py-2 text-xs">
                <span>{t('standup.queue.excludedNotice', { name: lastExclusion.name })}</span>
                <button type="button" className="font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded" onClick={() => {
                  undoFocusRef.current = lastExclusion.memberId;
                  setExcludedMemberIds(lastExclusion.ids);
                  setOrder(lastExclusion.order);
                  setOrderSource(lastExclusion.source);
                  setLastExclusion(undefined);
                }}>{t('standup.queue.undo')}</button>
              </div>}
            </div>
          )}
          {!groups.length && <p role="status" className="text-sm text-muted-foreground">{t(fullGroups.length ? 'standup.queue.allExcluded' : 'standup.noActiveMembers')}</p>}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border flex flex-wrap items-center justify-between gap-3 flex-shrink-0">
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {t('standup.settings.totalDuration')}<strong className="text-foreground">{totalMins} {t('common.minutes')}</strong>
          </span>
          <div className="ml-auto flex shrink-0 gap-2">
            <button
              onClick={handleCancel}
              className="px-4 py-2 rounded text-sm whitespace-nowrap border border-border text-foreground hover:bg-accent transition-colors"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={handleConfirm}
              disabled={!groups.length}
              className="px-4 py-2 rounded text-sm whitespace-nowrap bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              {t('standup.startButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default StandupLaunchDialog;
