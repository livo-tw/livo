import type { Task, TaskTodo } from '@/types';
import type { OtherViewer } from './types';
import { useTaskWorkList } from './useTaskWorkList';
interface TodosDeps { task: Task | null; selectedTaskId: string | undefined; globalTodos: TaskTodo[]; currentMemberId: string; getFieldLocker: (key: string) => OtherViewer | undefined; trackPresence: (fields?: Record<string, unknown>) => Promise<void> }
export function useTaskDetailTodos({ globalTodos, ...props }: TodosDeps) {
  const state = useTaskWorkList({ ...props, globalItems: globalTodos, list: 'todos' });
  return { todos: state.items, newTodoText: state.newText, setNewTodoText: state.setNewText,
    editingTodoId: state.editingId, editingTodoText: state.editingText, setEditingTodoText: state.setEditingText,
    loadTodosFromDb: state.load, toggleTodo: state.toggle, removeTodo: state.remove, addTodo: state.add,
    startEditTodo: state.startEdit, saveEditTodo: state.saveEdit, cancelEditTodo: state.cancelEdit };
}
