import type { Task, TaskCheck } from '@/types';
import type { OtherViewer } from './types';
import { useTaskWorkList } from './useTaskWorkList';
interface ChecklistDeps { task: Task | null; selectedTaskId: string | undefined; taskChecks: TaskCheck[]; currentMemberId: string; getFieldLocker: (key: string) => OtherViewer | undefined; trackPresence: (fields?: Record<string, unknown>) => Promise<void> }
export function useTaskDetailChecklist({ taskChecks, ...props }: ChecklistDeps) {
  const state = useTaskWorkList({ ...props, globalItems: taskChecks, list: 'checks' });
  const checkedCount = state.items.filter(item => item.isDone).length;
  return { checks: state.items, newCheckText: state.newText, setNewCheckText: state.setNewText,
    editingCheckId: state.editingId, editingCheckText: state.editingText, setEditingCheckText: state.setEditingText,
    checkedCount, allChecked: state.items.length > 0 && checkedCount === state.items.length,
    loadChecksFromDb: state.load, toggleCheck: state.toggle, removeCheck: state.remove, addCheck: state.add,
    startEditCheck: state.startEdit, saveEditCheck: state.saveEdit, cancelEditCheck: state.cancelEdit };
}
