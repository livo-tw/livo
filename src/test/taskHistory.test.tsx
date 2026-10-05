import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useState } from 'react';
import type { Task } from '@/types';
import { useTaskHistory } from '@/hooks/useTaskHistory';

const tasks = [{ id: 't1', taskKey: 'APP-1', title: 'One' }, { id: 't2', taskKey: 'APP-2', title: 'Two' }] as Task[];
const setup = () => renderHook(() => { const [task, setTask] = useState<Task | null>(null); useTaskHistory(task, setTask, tasks); return { task, setTask }; });
const param = () => new URLSearchParams(window.location.search).get('task');
const goTo = (search: string) => act(() => { window.history.replaceState(null, '', `/demo/${search}`); window.dispatchEvent(new PopStateEvent('popstate')); });
afterEach(() => window.history.replaceState(null, '', '/'));

describe('an open task in the browser history', () => {
  it('adds an entry when a task opens, so Back closes it and Forward opens it again', () => {
    window.history.replaceState(null, '', '/demo/?kb=page-1');
    const { result } = setup();
    const before = window.history.length;
    act(() => result.current.setTask(tasks[0]));
    expect(param()).toBe('APP-1');
    expect(window.history.length).toBe(before + 1);
    // Other views' parameters stay.
    expect(new URLSearchParams(window.location.search).get('kb')).toBe('page-1');
    goTo('?kb=page-1');
    expect(result.current.task).toBeNull();
    goTo('?kb=page-1&task=APP-2');
    expect(result.current.task?.id).toBe('t2');
  });

  it('closing in the app only removes the parameter', () => {
    window.history.replaceState(null, '', '/demo/');
    const { result } = setup();
    act(() => result.current.setTask(tasks[0]));
    const length = window.history.length;
    act(() => result.current.setTask(null));
    expect(param()).toBeNull();
    expect(window.history.length).toBe(length);
  });

  it('ignores a history entry for a task that no longer exists', () => {
    window.history.replaceState(null, '', '/demo/');
    const { result } = setup();
    goTo('?task=GONE-9');
    expect(result.current.task).toBeNull();
  });
});
