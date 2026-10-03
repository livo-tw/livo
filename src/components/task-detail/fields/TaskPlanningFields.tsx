import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Task } from '@/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import DatePickerField from './DatePickerField';
import { deadlineReasonRequired, pauseThroughDay, reminderPaused, type DeadlineState, type DueDateKind } from '@/lib/taskPlanning/core';
import { getTaskDeadlineHistory, getTaskReminder, planningErrorCode, setTaskDeadline, setTaskReminder, type TaskDeadline, type TaskDeadlineHistory, type TaskReminder } from '@/lib/taskPlanning/client';

type Props = { task: Task; memberId: string | null; users: { id: string; name: string }[]; onSaved: (row: TaskDeadline) => void };
type Draft = { scope: string; before: DeadlineState; date: string | null; kind: DueDateKind; reason: string };
const localDay = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;

export default function TaskPlanningFields({ task, memberId, users, onSaved }: Props) {
  const { t, i18n } = useTranslation();
  const scope = `${memberId || ''}:${task.id}`;
  const generation = useRef(0);
  const historyGeneration = useRef(0);
  const activeScope = useRef(scope);
  activeScope.current = scope;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [reminder, setReminder] = useState<{ scope: string; loaded: boolean; row: TaskReminder | null; error: string }>({ scope: '', loaded: false, row: null, error: '' });
  const [pauseDay, setPauseDay] = useState('');
  const [reminderSaving, setReminderSaving] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [history, setHistory] = useState<{ scope: string; rows: TaskDeadlineHistory[]; loading: boolean; error: string } | null>(null);
  const kindLabel = (kind: DueDateKind) => t(`taskPlanning.kinds.${kind || 'unknown'}`);

  useEffect(() => {
    const token = ++generation.current;
    ++historyGeneration.current;
    setDraft(null); setError(''); setSaving(false); setReminderSaving(false); setPauseDay(''); setHistory(null);
    setReminder({ scope, loaded: false, row: null, error: '' });
    if (!memberId) return;
    void getTaskReminder(task.id, memberId).then(row => {
      if (generation.current === token) setReminder({ scope, loaded: true, row, error: '' });
    }).catch(failure => {
      if (generation.current === token) setReminder({ scope, loaded: false, row: null, error: planningErrorCode(failure) });
    });
    return () => { ++generation.current; };
  }, [scope, task.id, memberId]);

  const ownReminder = reminder.scope === scope ? reminder : null;
  const until = ownReminder?.row?.snoozed_until;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wake = () => {
      setNow(new Date());
      const remaining = until ? Date.parse(until) - Date.now() : 0;
      if (remaining > 0) timer = setTimeout(wake, Math.min(remaining + 1, 2147483647));
    };
    wake();
    return () => { if (timer) clearTimeout(timer); };
  }, [until]);

  const openDeadline = (date: string | null) => {
    setDraft({ scope, before: { dueDate: task.dueDate || null, kind: task.dueDateKind ?? null, version: task.dueDateVersion ?? 0 }, date, kind: date ? task.dueDateKind ?? null : null, reason: '' });
    setError('');
  };
  const saveDeadline = async () => {
    if (!draft || draft.scope !== scope || saving) return;
    const capturedScope = scope, token = generation.current;
    setSaving(true); setError('');
    try {
      const row = await setTaskDeadline(task.id, draft.before, draft.date, draft.date ? draft.kind : null, draft.reason);
      if (activeScope.current !== capturedScope || generation.current !== token) return;
      onSaved(row); setDraft(null);
    } catch (failure) {
      if (activeScope.current === capturedScope && generation.current === token) setError(planningErrorCode(failure));
    } finally {
      if (activeScope.current === capturedScope && generation.current === token) setSaving(false);
    }
  };
  const saveReminder = async (resume = false) => {
    if (!memberId || !ownReminder?.loaded || reminderSaving) return;
    const capturedScope = scope, token = generation.current;
    setReminderSaving(true);
    try {
      const next = resume ? null : pauseThroughDay(pauseDay, Intl.DateTimeFormat().resolvedOptions().timeZone);
      const row = await setTaskReminder(task.id, ownReminder.row?.version ?? 0, next);
      if (activeScope.current === capturedScope && generation.current === token) {
        setReminder({ scope, loaded: true, row, error: '' }); setNow(new Date()); setPauseDay('');
      }
    } catch (failure) {
      if (activeScope.current === capturedScope && generation.current === token) setReminder(previous => ({ ...previous, error: planningErrorCode(failure) }));
    } finally {
      if (activeScope.current === capturedScope && generation.current === token) setReminderSaving(false);
    }
  };
  const openHistory = async () => {
    const token = generation.current;
    const request = ++historyGeneration.current;
    setHistory({ scope, loading: true, rows: [], error: '' });
    try {
      const rows = await getTaskDeadlineHistory(task.id);
      if (generation.current === token && historyGeneration.current === request && activeScope.current === scope) setHistory({ scope, rows, loading: false, error: '' });
    } catch (failure) {
      if (generation.current === token && historyGeneration.current === request && activeScope.current === scope) setHistory({ scope, rows: [], loading: false, error: planningErrorCode(failure) });
    }
  };
  const paused = reminderPaused(until, now);
  const maxPause = new Date(); maxPause.setDate(maxPause.getDate() + 365);
  const validPause = /^\d{4}-\d{2}-\d{2}$/.test(pauseDay) && pauseDay >= localDay(new Date()) && pauseDay <= localDay(maxPause);
  const reasonRequired = draft ? deadlineReasonRequired(draft.before, draft.date) : false;

  return <div className="space-y-2">
    <DatePickerField value={task.dueDate} onChange={value => openDeadline(value || null)} mode="due" startDate={task.startedAt?.slice(0, 10)} minDate={task.startedAt?.slice(0, 10)} />
    <div className="flex flex-wrap gap-2 text-xs">
      <button type="button" onClick={() => openDeadline(task.dueDate || null)} className="underline text-muted-foreground">{kindLabel(task.dueDateKind ?? null)}</button>
      <button type="button" onClick={() => void openHistory()} className="underline">{t('taskPlanning.history')}</button>
    </div>
    {memberId && <div className="rounded border p-2 space-y-2 text-xs">
      <p className="font-medium">{t('taskPlanning.personalReminder')}</p>
      <p className="text-muted-foreground">{t('taskPlanning.reminderDescription')}</p>
      <p>{!ownReminder?.loaded ? t('taskPlanning.loading') : paused ? t('taskPlanning.pausedUntil', { until: new Date(until!).toLocaleString(i18n.language) }) : t('taskPlanning.reminderActive')}</p>
      <label className="block">{t('taskPlanning.pauseThrough')}<input type="date" value={pauseDay} min={localDay(new Date())} max={localDay(maxPause)} onChange={event => setPauseDay(event.target.value)} className="block w-full rounded border bg-background px-2 py-1 mt-1" disabled={reminderSaving} /></label>
      <div className="flex gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!ownReminder?.loaded || !validPause || reminderSaving} onClick={() => void saveReminder()}>{t('taskPlanning.pause')}</Button>
        {paused && <Button type="button" size="sm" variant="outline" disabled={reminderSaving} onClick={() => void saveReminder(true)}>{t('taskPlanning.resume')}</Button>}
      </div>
      {ownReminder?.error && <p role="alert">{t(`taskPlanning.errors.${ownReminder.error}`)}</p>}
    </div>}
    <Dialog open={draft?.scope === scope} onOpenChange={open => { if (!open && !saving) setDraft(null); }}>
      <DialogContent><DialogHeader><DialogTitle>{t('taskPlanning.editDeadline')}</DialogTitle><DialogDescription>{t('taskPlanning.deadlineDescription')}</DialogDescription></DialogHeader>
        {draft?.scope === scope && <form onSubmit={event => { event.preventDefault(); void saveDeadline(); }} className="space-y-3">
          <label className="block">{t('taskPlanning.date')}<input type="date" value={draft.date || ''} min={task.startedAt?.slice(0, 10)} disabled={saving} onChange={event => setDraft({ ...draft, date: event.target.value || null, kind: event.target.value ? draft.kind : null })} className="block w-full rounded border bg-background p-2" /></label>
          <label className="block">{t('taskPlanning.kind')}<select value={draft.kind || ''} disabled={saving || !draft.date} onChange={event => setDraft({ ...draft, kind: event.target.value as DueDateKind || null })} className="block w-full rounded border bg-background p-2">
            <option value="">{kindLabel(null)}</option><option value="estimated">{kindLabel('estimated')}</option><option value="committed">{kindLabel('committed')}</option>
          </select></label>
          <label className="block">{t(reasonRequired ? 'taskPlanning.reasonRequired' : 'taskPlanning.reason')}<textarea value={draft.reason} maxLength={2000} required={reasonRequired} disabled={saving} onChange={event => setDraft({ ...draft, reason: event.target.value })} className="block w-full rounded border bg-background p-2" /></label>
          {error && <p role="alert">{t(`taskPlanning.errors.${error}`)}</p>}
          <div className="flex justify-end gap-2"><Button type="button" variant="outline" disabled={saving} onClick={() => setDraft(null)}>{t('common.cancel')}</Button><Button type="submit" disabled={saving || (reasonRequired && !draft.reason.trim())}>{t('common.save')}</Button></div>
        </form>}
      </DialogContent>
    </Dialog>
    <Dialog open={history?.scope === scope} onOpenChange={open => { if (!open) { ++historyGeneration.current; setHistory(null); } }}><DialogContent><DialogHeader><DialogTitle>{t('taskPlanning.history')}</DialogTitle><DialogDescription>{t('taskPlanning.historyDescription')}</DialogDescription></DialogHeader>
      <div className="max-h-96 overflow-auto space-y-3">
        {history?.loading && <p>{t('taskPlanning.loading')}</p>}
        {history?.error && <p role="alert">{t(`taskPlanning.errors.${history.error}`)}</p>}
        {history && !history.loading && !history.error && !history.rows.length && <p>{t('taskPlanning.historyEmpty')}</p>}
        {history?.rows.map(row => <div key={row.id} className="rounded border p-2 text-sm">
          <p>{row.previous_due_date || '—'} ({kindLabel(row.previous_kind)}) → {row.next_due_date || '—'} ({kindLabel(row.next_kind)})</p>
          <p className="text-muted-foreground">{users.find(user => user.id === row.actor_id)?.name || t('taskPlanning.actorUnknown')} · {new Date(row.changed_at).toLocaleString(i18n.language)}</p>
          {row.reason && <p className="whitespace-pre-wrap">{row.reason}</p>}
        </div>)}
      </div>
    </DialogContent></Dialog>
  </div>;
}
