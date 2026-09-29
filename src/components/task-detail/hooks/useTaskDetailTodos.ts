import { useState, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task, TaskTodo } from '@/types';
import type { Tables } from '@/integrations/supabase/types';
import { logActivity } from '@/lib/activityLog';
import type { OtherViewer } from './types';

interface TodosDeps {
  task: Task | null;
  selectedTaskId: string | undefined;
  globalTodos: TaskTodo[];
  currentMemberId: string;
  getFieldLocker: (fieldKey: string) => OtherViewer | undefined;
  trackPresence: (extraFields?: Record<string, unknown>) => Promise<void>;
}

export function useTaskDetailTodos({
  task, selectedTaskId, globalTodos, currentMemberId, getFieldLocker, trackPresence,
}: TodosDeps) {
  const [todos, setTodos] = useState<TaskTodo[]>([]);
  const [newTodoText, setNewTodoText] = useState('');
  const [editingTodoId, setEditingTodoId] = useState<string | null>(null);
  const [editingTodoText, setEditingTodoText] = useState('');

  // Reset + load on task change
  useEffect(() => {
    if (!selectedTaskId) return;
    setNewTodoText('');
    setEditingTodoId(null);
    setEditingTodoText('');
    loadTodosFromDb(selectedTaskId);
  }, [selectedTaskId]);

  // Sync from global todos state
  useEffect(() => {
    if (!selectedTaskId) return;
    const filtered = globalTodos.filter(t => t.taskId === selectedTaskId);
    setTodos(filtered.sort((a, b) => a.sortOrder - b.sortOrder));
  }, [globalTodos, selectedTaskId]);

  const loadTodosFromDb = async (taskId: string) => {
    const { data } = await supabase.from('task_todos').select('*').eq('task_id', taskId).order('sort_order');
    if (data) {
      setTodos(data.map((t: Tables<'task_todos'>) => ({ id: t.id, taskId: t.task_id, text: t.text, isDone: t.is_done, sortOrder: t.sort_order })));
    } else {
      setTodos([...globalTodos.filter(t => t.taskId === taskId)]);
    }
  };

  const toggleTodo = async (todoId: string) => {
    if (!task) return;
    const todo = todos.find(t => t.id === todoId);
    if (!todo) return;
    const newVal = !todo.isDone;
    setTodos(prev => prev.map(t => t.id === todoId ? { ...t, isDone: newVal } : t));
    const { error } = await supabase.from('task_todos').update({ is_done: newVal }).eq('id', todoId);
    if (error) toast.error(i18n.t('taskDetail.todos.updateFailed'));
    else logActivity(currentMemberId, 'toggle_todo', i18n.t('taskDetail.todos.toggleActivity', { text: todo.text, status: newVal ? i18n.t('taskDetail.checklist.done') : i18n.t('taskDetail.checklist.notDone') }), task.id, task.taskKey);
  };

  const removeTodo = async (todoId: string) => {
    setTodos(prev => prev.filter(t => t.id !== todoId));
    await supabase.from('task_todos').delete().eq('id', todoId);
  };

  const addTodo = async () => {
    if (!task || !newTodoText.trim()) return;
    const newTodo: TaskTodo = { id: generateId('td'), taskId: task.id, text: newTodoText.trim(), isDone: false, sortOrder: todos.length + 1 };
    setTodos(prev => [...prev, newTodo]);
    setNewTodoText('');
    const { error } = await supabase.from('task_todos').insert({ id: newTodo.id, task_id: newTodo.taskId, text: newTodo.text, is_done: false, sort_order: newTodo.sortOrder });
    if (error) toast.error(i18n.t('taskDetail.todos.addFailed') + error.message);
    else logActivity(currentMemberId, 'add_todo', newTodo.text, task.id, task.taskKey);
  };

  const startEditTodo = (todo: TaskTodo) => {
    const lockKey = `todo_${todo.id}`;
    const locker = getFieldLocker(lockKey);
    if (locker) { toast.error(i18n.t('error.itemBeingEdited', { name: locker.name })); return; }
    setEditingTodoId(todo.id);
    setEditingTodoText(todo.text);
    trackPresence({ editingField: lockKey });
  };

  const saveEditTodo = async () => {
    if (!task || !editingTodoId || !editingTodoText.trim()) return;
    const oldTodo = todos.find(t => t.id === editingTodoId);
    setTodos(prev => prev.map(t => t.id === editingTodoId ? { ...t, text: editingTodoText.trim() } : t));
    await supabase.from('task_todos').update({ text: editingTodoText.trim() }).eq('id', editingTodoId);
    if (oldTodo) logActivity(currentMemberId, 'edit_todo', i18n.t('taskDetail.todos.editActivity', { oldText: oldTodo.text, newText: editingTodoText.trim() }), task.id, task.taskKey);
    setEditingTodoId(null);
    setEditingTodoText('');
    trackPresence({ editingField: null });
  };

  const cancelEditTodo = () => {
    setEditingTodoId(null);
    setEditingTodoText('');
    trackPresence({ editingField: null });
  };

  return {
    todos,
    newTodoText, setNewTodoText,
    editingTodoId, editingTodoText, setEditingTodoText,
    loadTodosFromDb,
    toggleTodo, removeTodo, addTodo,
    startEditTodo, saveEditTodo, cancelEditTodo,
  };
}
