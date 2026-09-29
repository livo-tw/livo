import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task, TaskCheck } from '@/types';
import type { Tables } from '@/integrations/supabase/types';
import { logActivity } from '@/lib/activityLog';
import type { OtherViewer } from './types';

interface ChecklistDeps {
  task: Task | null;
  selectedTaskId: string | undefined;
  taskChecks: TaskCheck[];
  currentMemberId: string;
  getFieldLocker: (fieldKey: string) => OtherViewer | undefined;
  trackPresence: (extraFields?: Record<string, unknown>) => Promise<void>;
}

export function useTaskDetailChecklist({
  task, selectedTaskId, taskChecks, currentMemberId, getFieldLocker, trackPresence,
}: ChecklistDeps) {
  const [checks, setChecks] = useState<TaskCheck[]>([]);
  const [newCheckText, setNewCheckText] = useState('');
  const [editingCheckId, setEditingCheckId] = useState<string | null>(null);
  const [editingCheckText, setEditingCheckText] = useState('');

  // Reset + load on task change
  useEffect(() => {
    if (!selectedTaskId) return;
    setNewCheckText('');
    setEditingCheckId(null);
    setEditingCheckText('');
    loadChecksFromDb(selectedTaskId);
  }, [selectedTaskId]);

  // Sync from global checks state
  useEffect(() => {
    if (!selectedTaskId) return;
    const filtered = taskChecks.filter(c => c.taskId === selectedTaskId);
    setChecks(filtered.sort((a, b) => a.sortOrder - b.sortOrder));
  }, [taskChecks, selectedTaskId]);

  const loadChecksFromDb = async (taskId: string) => {
    const { data } = await supabase.from('task_checks').select('*').eq('task_id', taskId).order('sort_order');
    if (data) {
      setChecks(data.map((c: Tables<'task_checks'>) => ({ id: c.id, taskId: c.task_id, text: c.text, isDone: c.is_done, sortOrder: c.sort_order })));
    } else {
      setChecks([...taskChecks.filter(c => c.taskId === taskId)]);
    }
  };

  const toggleCheck = async (checkId: string) => {
    if (!task) return;
    const check = checks.find(c => c.id === checkId);
    if (!check) return;
    const newVal = !check.isDone;
    setChecks(prev => prev.map(c => c.id === checkId ? { ...c, isDone: newVal } : c));
    const { error } = await supabase.from('task_checks').update({ is_done: newVal }).eq('id', checkId);
    if (error) toast.error(i18n.t('taskDetail.checklist.updateFailed'));
    else logActivity(currentMemberId, 'toggle_check', i18n.t('taskDetail.checklist.toggleActivity', { text: check.text, status: newVal ? i18n.t('taskDetail.checklist.done') : i18n.t('taskDetail.checklist.notDone') }), task.id, task.taskKey);
  };

  const removeCheck = async (checkId: string) => {
    setChecks(prev => prev.filter(c => c.id !== checkId));
    await supabase.from('task_checks').delete().eq('id', checkId);
  };

  const addCheck = async () => {
    if (!task || !newCheckText.trim()) return;
    const newCheck: TaskCheck = { id: generateId('tc'), taskId: task.id, text: newCheckText.trim(), isDone: false, sortOrder: checks.length + 1 };
    setChecks(prev => [...prev, newCheck]);
    setNewCheckText('');
    const { error } = await supabase.from('task_checks').insert({ id: newCheck.id, task_id: newCheck.taskId, text: newCheck.text, is_done: false, sort_order: newCheck.sortOrder });
    if (error) toast.error(i18n.t('taskDetail.checklist.addFailed') + error.message);
    else logActivity(currentMemberId, 'add_check', newCheck.text, task.id, task.taskKey);
  };

  const startEditCheck = (check: TaskCheck) => {
    const lockKey = `check_${check.id}`;
    const locker = getFieldLocker(lockKey);
    if (locker) { toast.error(i18n.t('error.itemBeingEdited', { name: locker.name })); return; }
    setEditingCheckId(check.id);
    setEditingCheckText(check.text);
    trackPresence({ editingField: lockKey });
  };

  const saveEditCheck = async () => {
    if (!task || !editingCheckId || !editingCheckText.trim()) return;
    const oldCheck = checks.find(c => c.id === editingCheckId);
    setChecks(prev => prev.map(c => c.id === editingCheckId ? { ...c, text: editingCheckText.trim() } : c));
    await supabase.from('task_checks').update({ text: editingCheckText.trim() }).eq('id', editingCheckId);
    if (oldCheck) logActivity(currentMemberId, 'edit_check', i18n.t('taskDetail.checklist.editActivity', { oldText: oldCheck.text, newText: editingCheckText.trim() }), task.id, task.taskKey);
    setEditingCheckId(null);
    setEditingCheckText('');
    trackPresence({ editingField: null });
  };

  const cancelEditCheck = () => {
    setEditingCheckId(null);
    setEditingCheckText('');
    trackPresence({ editingField: null });
  };

  const checkedCount = checks.filter(c => c.isDone).length;
  const allChecked = checks.length > 0 && checkedCount === checks.length;

  return {
    checks,
    newCheckText, setNewCheckText,
    editingCheckId, editingCheckText, setEditingCheckText,
    checkedCount, allChecked,
    loadChecksFromDb,
    toggleCheck, removeCheck, addCheck,
    startEditCheck, saveEditCheck, cancelEditCheck,
  };
}
