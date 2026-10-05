import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Task } from '@/types';

/**
 * An open task is a step in the browser history, so Back (and the Android back
 * button) closes it instead of leaving the app, and Forward opens it again.
 * Opening adds an entry with ?task=KEY; closing in the app only removes the
 * parameter, so it never moves the history under another view's own parameters.
 */
export function useTaskHistory(selectedTask: Task | null, setSelectedTask: Dispatch<SetStateAction<Task | null>>, allTasks: Task[]) {
  const current = useRef(selectedTask); current.current = selectedTask;
  const tasks = useRef(allTasks); tasks.current = allTasks;
  const key = selectedTask ? selectedTask.taskKey || selectedTask.id : null;

  useEffect(() => {
    const url = new URL(window.location.href);
    const inUrl = url.searchParams.get('task');
    if (key && inUrl !== key) {
      url.searchParams.set('task', key);
      window.history.pushState({ ...(window.history.state || {}), livoTask: key }, '', url.toString());
    } else if (!key && inUrl) {
      url.searchParams.delete('task');
      window.history.replaceState(window.history.state, '', url.toString());
    }
  }, [key]);

  useEffect(() => {
    const onPop = () => {
      const wanted = new URLSearchParams(window.location.search).get('task');
      const open = current.current;
      if (!wanted) { if (open) setSelectedTask(null); return; }
      if (open && (open.taskKey === wanted || open.id === wanted)) return;
      const found = tasks.current.find(task => task.taskKey === wanted || task.id === wanted);
      if (found) setSelectedTask(found);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [setSelectedTask]);
}
