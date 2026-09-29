import { useEffect } from 'react';
import { UndoStackContext, useUndoStackState } from '@/hooks/useUndoStack';

export default function UndoStackProvider({ children }: { children: React.ReactNode }) {
  const api = useUndoStackState();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;
        e.preventDefault();
        api.undoLast();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [api]);

  return (
    <UndoStackContext.Provider value={api}>
      {children}
    </UndoStackContext.Provider>
  );
}
