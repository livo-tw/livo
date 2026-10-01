// 時間追蹤 tab (task detail).
//
// Backend: time_entries table via the supabase-compatible client.
//   { id, task_id, member_id, minutes:int, note, entry_date:'YYYY-MM-DD',
//     started_at?:ISO, ended_at?:ISO, created_at, updated_at }
// A running timer is a row with started_at set, ended_at null and minutes 0.
// The server enforces own-rows for the member role (admin+ can edit anyone's);
// the UI additionally hides edit/delete on other people's rows for non-admins.
//
// Data is refetched on tab open (mount) and after every mutation — same
// lean loading approach as the comments tab. v1 deliberately has NO global
// floating timer widget (start/stop lives only in this tab); a cross-view
// timer indicator is a future enhancement.

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Play, Square, Loader2, Timer, Plus, Trash2, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { TaskDetailState } from './hooks/useTaskDetail';
import { randomUUID } from '@/lib/generateId';

type Props = { detail: TaskDetailState };

interface TimeEntry {
  id: string;
  task_id: string;
  member_id: string;
  minutes: number;
  note: string;
  entry_date: string; // YYYY-MM-DD
  started_at: string | null;
  ended_at: string | null;
  created_at: string;
  updated_at?: string;
}

const localToday = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Whole minutes between two ISO timestamps, at least 1 so a stopped timer never records nothing. */
const elapsedMinutes = (startIso: string, endIso: string): number =>
  Math.max(1, Math.round((Date.parse(endIso) - Date.parse(startIso)) / 60000));

/** h:mm duration, e.g. 90 → "1:30". */
const fmtHM = (mins: number): string => `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;

/** h:mm:ss ticking display for the running timer. */
const fmtHMS = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

const isRunning = (e: TimeEntry): boolean => !!e.started_at && !e.ended_at;

// A bare UUID: the self-host (Postgres) time_entries.id column is uuid, so a
// prefixed id like "te_<uuid>" is rejected there. The Cloudflare build stores
// any TEXT id, so this works on both backends.
const newEntryId = (): string => randomUUID();

// The generated supabase types predate the time_entries table, so query it
// through a minimal structural facade (runtime behaviour is unchanged — the
// same client serves both backends).
type Row = Record<string, unknown>;
interface TeResult { data: Row[] | null; error: { message: string } | null }
interface TeFilter extends PromiseLike<TeResult> {
  eq(col: string, val: unknown): TeFilter;
}
interface TeTable {
  select(cols: string): TeFilter;
  insert(row: Row): PromiseLike<{ error: { message: string } | null }>;
  update(vals: Row): TeFilter;
  delete(): TeFilter;
}
const timeEntries = (): TeTable =>
  (supabase as unknown as { from(table: string): TeTable }).from('time_entries');

const TaskTimeTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const { task, users, currentMemberId, permissions, allTasks } = detail;
  const taskId = task?.id;

  const [entries, setEntries] = useState<TimeEntry[]>([]);
  const [myRunning, setMyRunning] = useState<TimeEntry | null>(null); // mine, on ANY task
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  // Manual add form
  const [manualHours, setManualHours] = useState('');
  const [manualMinutes, setManualMinutes] = useState('');
  const [manualDate, setManualDate] = useState(localToday());
  const [manualNote, setManualNote] = useState('');

  // Row editing / deleting
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHours, setEditHours] = useState('');
  const [editMinutes, setEditMinutes] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editNote, setEditNote] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Optional-note dialog after stopping the timer
  const [noteDialogEntryId, setNoteDialogEntryId] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  // Ticking clock for the running timer display
  const [nowTick, setNowTick] = useState(Date.now());

  const load = useCallback(async () => {
    if (!taskId || !currentMemberId) return;
    try {
      const [taskRes, runningRes] = await Promise.all([
        timeEntries().select('*').eq('task_id', taskId),
        // Running rows always have minutes 0 — cheap way to find my active timer on any task.
        timeEntries().select('*').eq('member_id', currentMemberId).eq('minutes', 0),
      ]);
      if (taskRes.error) {
        toast.error(t('taskDetail.time.loadFailed') + taskRes.error.message);
        return;
      }
      const rows = ((taskRes.data ?? []) as unknown as TimeEntry[]).slice().sort((a, b) => {
        if (isRunning(a) !== isRunning(b)) return isRunning(a) ? -1 : 1;
        if (a.entry_date !== b.entry_date) return a.entry_date < b.entry_date ? 1 : -1;
        return (a.created_at || '') < (b.created_at || '') ? 1 : -1;
      });
      setEntries(rows);
      const running = ((runningRes.data ?? []) as unknown as TimeEntry[])
        .filter(isRunning)
        .sort((a, b) => ((a.started_at || '') < (b.started_at || '') ? 1 : -1));
      setMyRunning(running[0] ?? null);
    } catch {
      /* transient network failure — keep whatever we had */
    }
  }, [taskId, currentMemberId, t]);

  // Fetch on tab open (this component mounts each time the tab is selected)
  useEffect(() => {
    let alive = true;
    setLoading(true);
    void (async () => {
      await load();
      if (alive) setLoading(false);
    })();
    return () => { alive = false; };
  }, [load]);

  const runningHere = myRunning && myRunning.task_id === taskId ? myRunning : null;

  useEffect(() => {
    if (!runningHere) return;
    const iv = setInterval(() => setNowTick(Date.now()), 1000);
    setNowTick(Date.now());
    return () => clearInterval(iv);
  }, [runningHere?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!task) return null;

  const canManageAll = permissions.canDeleteTask; // admin-style permission, mirrors server rule
  const canTouch = (e: TimeEntry) => e.member_id === currentMemberId || canManageAll;
  const memberName = (id: string) => users.find(u => u.id === id)?.name || t('common.unknown');

  // ── Timer actions ─────────────────────────────────────────────────────────

  const startTimer = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      // A member has at most one running timer — stop the one on another task first.
      if (myRunning && myRunning.task_id !== taskId) {
        const mins = elapsedMinutes(myRunning.started_at!, nowIso);
        const { error } = await timeEntries()
          .update({ minutes: mins, ended_at: nowIso })
          .eq('id', myRunning.id);
        if (error) {
          toast.error(t('taskDetail.time.startFailed') + error.message);
          return;
        }
        const otherTask = allTasks.find(tk => tk.id === myRunning.task_id);
        toast.info(t('taskDetail.time.stoppedOtherTask', { key: otherTask?.taskKey || '?', minutes: mins }));
      }
      const { error } = await timeEntries().insert({
        id: newEntryId(),
        task_id: taskId,
        member_id: currentMemberId,
        minutes: 0,
        note: '',
        entry_date: localToday(),
        started_at: nowIso,
        ended_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (error) toast.error(t('taskDetail.time.startFailed') + error.message);
      else toast.success(t('taskDetail.time.timerStarted'));
      await load();
    } catch (err) {
      toast.error(t('taskDetail.time.startFailed') + (err instanceof Error ? err.message : t('error.unexpectedError')));
    } finally {
      setBusy(false);
    }
  };

  const stopTimer = async () => {
    if (!runningHere || busy) return;
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const mins = elapsedMinutes(runningHere.started_at!, nowIso);
      const { error } = await timeEntries()
        .update({ minutes: mins, ended_at: nowIso })
        .eq('id', runningHere.id);
      if (error) {
        toast.error(t('taskDetail.time.stopFailed') + error.message);
        return;
      }
      toast.success(t('taskDetail.time.timerStopped', { minutes: mins }));
      // Timer is already stopped — the dialog only offers an optional note.
      setNoteText('');
      setNoteDialogEntryId(runningHere.id);
      await load();
    } catch (err) {
      toast.error(t('taskDetail.time.stopFailed') + (err instanceof Error ? err.message : t('error.unexpectedError')));
    } finally {
      setBusy(false);
    }
  };

  const saveStopNote = async () => {
    const entryId = noteDialogEntryId;
    const note = noteText.trim();
    setNoteDialogEntryId(null);
    if (!entryId || !note) return;
    const { error } = await timeEntries().update({ note }).eq('id', entryId);
    if (error) toast.error(t('taskDetail.time.saveFailed') + error.message);
    await load();
  };

  // ── Manual add ────────────────────────────────────────────────────────────

  const addManual = async () => {
    if (busy) return;
    const total = (parseInt(manualHours, 10) || 0) * 60 + (parseInt(manualMinutes, 10) || 0);
    if (total <= 0) {
      toast.error(t('taskDetail.time.invalidDuration'));
      return;
    }
    setBusy(true);
    try {
      const nowIso = new Date().toISOString();
      const { error } = await timeEntries().insert({
        id: newEntryId(),
        task_id: taskId,
        member_id: currentMemberId,
        minutes: total,
        note: manualNote.trim(),
        entry_date: manualDate || localToday(),
        started_at: null,
        ended_at: null,
        created_at: nowIso,
        updated_at: nowIso,
      });
      if (error) {
        toast.error(t('taskDetail.time.saveFailed') + error.message);
        return;
      }
      setManualHours('');
      setManualMinutes('');
      setManualDate(localToday());
      setManualNote('');
      toast.success(t('taskDetail.time.added'));
      await load();
    } catch (err) {
      toast.error(t('taskDetail.time.saveFailed') + (err instanceof Error ? err.message : t('error.unexpectedError')));
    } finally {
      setBusy(false);
    }
  };

  // ── Edit / delete ─────────────────────────────────────────────────────────

  const startEdit = (e: TimeEntry) => {
    setEditingId(e.id);
    setEditHours(String(Math.floor(e.minutes / 60)));
    setEditMinutes(String(e.minutes % 60));
    setEditDate(e.entry_date);
    setEditNote(e.note || '');
    setConfirmDeleteId(null);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const total = (parseInt(editHours, 10) || 0) * 60 + (parseInt(editMinutes, 10) || 0);
    if (total <= 0) {
      toast.error(t('taskDetail.time.invalidDuration'));
      return;
    }
    const { error } = await timeEntries()
      .update({ minutes: total, entry_date: editDate || localToday(), note: editNote.trim() })
      .eq('id', editingId);
    if (error) {
      toast.error(t('taskDetail.time.saveFailed') + error.message);
      return;
    }
    setEditingId(null);
    toast.success(t('taskDetail.time.updated'));
    await load();
  };

  const deleteEntry = async (id: string) => {
    const { error } = await timeEntries().delete().eq('id', id);
    setConfirmDeleteId(null);
    if (error) {
      toast.error(t('taskDetail.time.deleteFailed') + error.message);
      return;
    }
    toast.success(t('taskDetail.time.deleted'));
    await load();
  };

  // ── Totals ────────────────────────────────────────────────────────────────

  const totalMinutes = entries.reduce((sum, e) => sum + (e.minutes || 0), 0);
  const perMember = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.member_id] = (acc[e.member_id] || 0) + (e.minutes || 0);
    return acc;
  }, {});

  const numInputCls = 'w-16 border border-border rounded px-2 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary';

  return (
    <div className="space-y-5">
      {/* ── Timer block ── */}
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3">
        {runningHere ? (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2.5 min-w-0">
              <span className="relative flex h-2.5 w-2.5 flex-shrink-0">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-green-500" />
              </span>
              <div className="min-w-0">
                <div className="text-lg font-bold tabular-nums text-foreground leading-tight">
                  {fmtHMS(nowTick - Date.parse(runningHere.started_at!))}
                </div>
                <div className="text-[11px] text-muted-foreground">{t('taskDetail.time.timerRunning')}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => void stopTimer()}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Square size={13} />}
              {t('taskDetail.time.stop')}
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
              <Timer size={16} className="flex-shrink-0" />
              {myRunning ? (
                <span className="text-xs text-amber-600 dark:text-amber-400">
                  {t('taskDetail.time.startWillStopOther', {
                    key: allTasks.find(tk => tk.id === myRunning.task_id)?.taskKey || '?',
                  })}
                </span>
              ) : (
                <span className="text-xs">{t('taskDetail.time.timerHint')}</span>
              )}
            </div>
            <button
              type="button"
              onClick={() => void startTimer()}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {busy ? <Loader2 size={14} className="animate-spin" /> : <Play size={13} />}
              {t('taskDetail.time.start')}
            </button>
          </div>
        )}
      </div>

      {/* ── Manual add ── */}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
          {t('taskDetail.time.manualTitle')}
        </h4>
        <div className="flex items-end gap-2 flex-wrap">
          <div>
            <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.hoursLabel')}</label>
            <input type="number" min={0} value={manualHours} onChange={e => setManualHours(e.target.value)}
              className={numInputCls} placeholder="0" />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.minutesLabel')}</label>
            <input type="number" min={0} max={59} value={manualMinutes} onChange={e => setManualMinutes(e.target.value)}
              className={numInputCls} placeholder="0" />
          </div>
          <div>
            <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.dateLabel')}</label>
            <input type="date" value={manualDate} onChange={e => setManualDate(e.target.value)}
              className="border border-border rounded px-2 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary" />
          </div>
          <div className="flex-1 min-w-[140px]">
            <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.noteLabel')}</label>
            <input type="text" value={manualNote} onChange={e => setManualNote(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void addManual(); }}
              className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
              placeholder={t('taskDetail.time.notePlaceholderManual')} />
          </div>
          <button
            type="button"
            onClick={() => void addManual()}
            disabled={busy}
            className="flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded border border-border text-foreground hover:bg-accent disabled:opacity-50 transition-colors"
          >
            <Plus size={13} />
            {t('taskDetail.time.addButton')}
          </button>
        </div>
      </div>

      {/* ── Entry list ── */}
      <div>
        <h4 className="text-xs font-medium uppercase tracking-wider text-muted-foreground mb-2">
          {t('taskDetail.time.entriesTitle')}
        </h4>
        {loading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
            <Loader2 size={14} className="animate-spin" />
            {t('common.loading')}
          </div>
        ) : entries.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-5">{t('taskDetail.time.empty')}</p>
        ) : (
          <div className="divide-y divide-border border border-border rounded-lg overflow-hidden">
            {entries.map(e => {
              const running = isRunning(e);
              const user = users.find(u => u.id === e.member_id);
              if (editingId === e.id) {
                return (
                  <div key={e.id} className="px-3 py-2.5 bg-muted/30 space-y-2">
                    <div className="flex items-end gap-2 flex-wrap">
                      <div>
                        <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.hoursLabel')}</label>
                        <input type="number" min={0} value={editHours} onChange={ev => setEditHours(ev.target.value)} className={numInputCls} />
                      </div>
                      <div>
                        <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.minutesLabel')}</label>
                        <input type="number" min={0} max={59} value={editMinutes} onChange={ev => setEditMinutes(ev.target.value)} className={numInputCls} />
                      </div>
                      <div>
                        <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.dateLabel')}</label>
                        <input type="date" value={editDate} onChange={ev => setEditDate(ev.target.value)}
                          className="border border-border rounded px-2 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                      <div className="flex-1 min-w-[140px]">
                        <label className="text-[11px] text-muted-foreground block mb-0.5">{t('taskDetail.time.noteLabel')}</label>
                        <input type="text" value={editNote} onChange={ev => setEditNote(ev.target.value)}
                          className="w-full border border-border rounded px-2 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary" />
                      </div>
                    </div>
                    <div className="flex gap-1.5">
                      <button type="button" onClick={() => void saveEdit()}
                        className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90">
                        {t('taskDetail.time.saveButton')}
                      </button>
                      <button type="button" onClick={() => setEditingId(null)}
                        className="px-2.5 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-accent">
                        {t('taskDetail.time.cancelButton')}
                      </button>
                    </div>
                  </div>
                );
              }
              return (
                <div key={e.id} className="flex items-center gap-3 px-3 py-2 group">
                  <div className="w-6 h-6 rounded-full flex-shrink-0 flex items-center justify-center text-[8px] font-bold text-white"
                    style={{ backgroundColor: user?.color || '#6B778C' }}>
                    {user?.avatar || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-foreground">{memberName(e.member_id)}</span>
                      <span className="text-xs text-muted-foreground">{e.entry_date}</span>
                      {running ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/10 text-green-600 dark:text-green-400 font-medium">
                          {t('taskDetail.time.timerRunning')}
                        </span>
                      ) : (
                        <span className="text-sm font-semibold tabular-nums text-foreground">{fmtHM(e.minutes)}</span>
                      )}
                    </div>
                    {e.note && <div className="text-xs text-muted-foreground truncate mt-0.5">{e.note}</div>}
                  </div>
                  {canTouch(e) && !running && (
                    confirmDeleteId === e.id ? (
                      <div className="flex items-center gap-1 text-xs flex-shrink-0">
                        <span className="text-muted-foreground">{t('taskDetail.time.deleteConfirm')}</span>
                        <button type="button" onClick={() => void deleteEntry(e.id)}
                          className="px-2 py-1 rounded bg-destructive text-destructive-foreground text-xs font-medium">
                          {t('taskDetail.time.deleteButton')}
                        </button>
                        <button type="button" onClick={() => setConfirmDeleteId(null)}
                          className="px-2 py-1 rounded text-xs text-muted-foreground hover:bg-accent">
                          {t('taskDetail.time.cancelButton')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button type="button" onClick={() => startEdit(e)}
                          className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
                          title={t('taskDetail.time.editButton')}>
                          <Pencil size={13} />
                        </button>
                        <button type="button" onClick={() => setConfirmDeleteId(e.id)}
                          className="p-1 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                          title={t('taskDetail.time.deleteButton')}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    )
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* ── Totals footer ── */}
        {entries.length > 0 && (
          <div className="mt-3 space-y-1">
            <div className="text-sm font-semibold text-foreground">
              {t('taskDetail.time.total', { hours: Math.floor(totalMinutes / 60), minutes: totalMinutes % 60 })}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
              {Object.entries(perMember).map(([memberId, mins]) => (
                <span key={memberId}>
                  {memberName(memberId)} <span className="tabular-nums font-medium">{fmtHM(mins)}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Optional note dialog after stopping the timer ── */}
      {noteDialogEntryId && createPortal(
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={() => void saveStopNote()}>
          <div role="dialog" aria-modal="true"
            className="bg-card rounded-xl shadow-xl border border-border p-5 w-full max-w-sm mx-4 animate-in fade-in zoom-in-95 duration-150"
            onClick={ev => ev.stopPropagation()}>
            <h3 className="text-base font-bold text-foreground mb-3">{t('taskDetail.time.noteDialogTitle')}</h3>
            <input
              type="text"
              value={noteText}
              onChange={ev => setNoteText(ev.target.value)}
              onKeyDown={ev => { if (ev.key === 'Enter') void saveStopNote(); }}
              placeholder={t('taskDetail.time.notePlaceholder')}
              autoFocus
              className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-background text-foreground outline-none focus:ring-1 focus:ring-primary"
            />
            <div className="flex gap-2 justify-end mt-4">
              <button type="button" onClick={() => setNoteDialogEntryId(null)}
                className="px-3 py-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
                {t('taskDetail.time.noteSkip')}
              </button>
              <button type="button" onClick={() => void saveStopNote()}
                className="px-4 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
                {t('taskDetail.time.noteSave')}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};

export default TaskTimeTab;
