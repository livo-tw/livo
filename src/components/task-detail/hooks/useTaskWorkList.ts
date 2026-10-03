import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { supabase } from '@/integrations/supabase/client';
import type { Task, TaskCheck } from '@/types';
import { createTaskWorkCommandRunner, getTaskWorkItems, taskWorkErrorCode, taskWorkItem, type TaskWorkIntent, type TaskWorkItem } from '@/lib/taskWork/client';
import type { OtherViewer } from './types';
type Props = { task: Task | null; selectedTaskId: string | undefined; globalItems: TaskCheck[]; currentMemberId: string; list: 'checks' | 'todos'; getFieldLocker: (key: string) => OtherViewer | undefined; trackPresence: (fields?: Record<string, unknown>) => Promise<void> };
type Edit = { id: string; version: number; text: string };
const mapped = (row: TaskWorkItem): TaskCheck => ({ id: row.id, taskId: row.task_id, text: row.text, isDone: row.is_done, sortOrder: row.sort_order, version: row.version });
export function useTaskWorkList({ task, selectedTaskId, globalItems, currentMemberId, list, getFieldLocker, trackPresence }: Props) {
  const scope = `${currentMemberId}:${selectedTaskId || ''}:${list}`;
  const active = useRef(scope); active.current = scope;
  const generation = useRef(0), reads = useRef(0);
  const pending = useRef(new Set<string>());
  const run = useMemo(() => createTaskWorkCommandRunner(supabase), [scope]);
  const fingerprint = globalItems.filter(item => item.taskId === selectedTaskId).map(item => `${item.id}:${item.version ?? 0}`).sort().join('|');
  const [state, setState] = useState<{ scope: string; rows: TaskCheck[]; loaded: boolean }>({ scope: '', rows: [], loaded: false });
  const [newText, setNewText] = useState('');
  const [edit, setEdit] = useState<Edit | null>(null);
  const [editingText, setEditingText] = useState('');
  const visibleEditingText = useRef(editingText); visibleEditingText.current = editingText;
  const current = state.scope === scope ? state : { scope, rows: [], loaded: false };
  const errorToast = (error: unknown) => toast.error(i18n.t(`taskWork.errors.${taskWorkErrorCode(error)}`));
  const load = useCallback(async (taskId: string) => {
    if (!currentMemberId || taskId !== selectedTaskId) return;
    const captured = scope, token = generation.current, request = ++reads.current;
    try {
      const rows = await getTaskWorkItems(supabase, list, taskId);
      if (active.current === captured && generation.current === token && reads.current === request) setState({ scope, rows: rows.map(mapped), loaded: true });
    } catch (error) {
      if (active.current === captured && generation.current === token && reads.current === request) { setState(previous => ({ ...previous, loaded: false })); errorToast(error); }
    }
  }, [scope, selectedTaskId, currentMemberId, list]);
  useEffect(() => {
    ++generation.current; ++reads.current; pending.current.clear();
    setState({ scope, rows: [], loaded: false }); setNewText(''); setEdit(null); setEditingText('');
    return () => { ++generation.current; ++reads.current; };
  }, [scope]);
  useEffect(() => { if (selectedTaskId) void load(selectedTaskId); }, [load, selectedTaskId, fingerprint]);
  const perform = async (intent: TaskWorkIntent, key: string, done?: (record: unknown) => void) => {
    if (active.current !== scope || !task || task.id !== selectedTaskId || !current.loaded || pending.current.has(key)) return false;
    const captured = scope, token = generation.current;
    pending.current.add(key);
    try {
      const result = await run(intent);
      if (active.current !== captured || generation.current !== token) return false;
      ++reads.current;
      let currentRecord: unknown = result.record;
      if (result.replayed) {
        const request = ++reads.current;
        try {
          const rows = await getTaskWorkItems(supabase, list, task.id);
          if (active.current !== captured || generation.current !== token) return false;
          if (reads.current === request) setState({ scope, rows: rows.map(mapped), loaded: true });
          if (result.record) currentRecord = rows.find(row => row.id === result.record!.id) ?? null;
        } catch {
          if (active.current !== captured || generation.current !== token) return false;
          if (reads.current === request) setState(previous => ({ ...previous, loaded: false }));
          toast.error(i18n.t('taskWork.refreshFailed'));
        }
      } else if (intent.operation === 'add_item' || intent.operation === 'update_item') {
        const row = mapped(taskWorkItem(result.record, task.id));
        setState(previous => ({ ...previous, rows: [...previous.rows.filter(item => item.id !== row.id || (item.version ?? 0) > (row.version ?? 0)),
          ...(previous.rows.some(item => item.id === row.id && (item.version ?? 0) > (row.version ?? 0)) ? [] : [row])].sort((a, b) => a.sortOrder - b.sortOrder) }));
      } else if (intent.operation === 'delete_item') {
        setState(previous => ({ ...previous, rows: previous.rows.filter(row => row.id !== intent.itemId) }));
      }
      done?.(currentRecord);
      return true;
    } catch (error) {
      if (active.current === captured && generation.current === token) errorToast(error);
      return false;
    } finally { if (active.current === captured && generation.current === token) pending.current.delete(key); }
  };
  const toggle = async (id: string) => {
    const item = current.rows.find(row => row.id === id); if (!item || !task) return;
    await perform({ operation: 'update_item', taskId: task.id, list, itemId: id, expectedVersion: item.version ?? 0, isDone: !item.isDone }, id);
  };
  const remove = async (id: string) => {
    const item = current.rows.find(row => row.id === id); if (!item || !task) return;
    await perform({ operation: 'delete_item', taskId: task.id, list, itemId: id, expectedVersion: item.version ?? 0 }, id);
  };
  const add = async () => {
    const text = newText.trim(); if (!task || !text) return;
    await perform({ operation: 'add_item', taskId: task.id, list, text, isDone: false }, 'add', () => {
      setNewText(previous => previous.trim() === text ? '' : previous);
    });
  };
  const startEdit = (item: TaskCheck) => {
    const key = `${list === 'checks' ? 'check' : 'todo'}_${item.id}`;
    const locker = getFieldLocker(key);
    if (locker) { toast.error(i18n.t('error.itemBeingEdited', { name: locker.name })); return; }
    setEdit({ id: item.id, version: item.version ?? 0, text: item.text }); setEditingText(item.text);
    void trackPresence({ editingField: key });
  };
  const cancelEdit = () => { setEdit(null); setEditingText(''); void trackPresence({ editingField: null }); };
  const saveEdit = async () => {
    if (!task || !edit || !editingText.trim()) return;
    const capturedEdit = edit, capturedText = editingText.trim();
    await perform({ operation: 'update_item', taskId: task.id, list, itemId: edit.id, expectedVersion: edit.version, text: capturedText }, edit.id, value => {
      const saved = value ? taskWorkItem(value, task.id) : null;
      const continuedEditing = visibleEditingText.current.trim() !== capturedText;
      setEdit(previous => previous !== capturedEdit ? previous : continuedEditing ? saved ? { id: saved.id, version: saved.version, text: saved.text } : previous : null);
      setEditingText(previous => previous.trim() === capturedText ? '' : previous);
      if (!continuedEditing) void trackPresence({ editingField: null });
    });
  };
  return { items: current.rows, newText, setNewText, editingId: edit?.id ?? null, editingText, setEditingText, load, toggle, remove, add, startEdit, saveEdit, cancelEdit };
}
