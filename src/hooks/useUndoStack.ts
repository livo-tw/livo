import { createContext, useContext, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { randomUUID } from '@/lib/generateId';

export interface UndoEntry {
  id: string;
  type: string;
  description: string;
  undo: () => Promise<void>;
  timestamp: number;
}

const MAX_STACK = 5;
const TOAST_DURATION = 5000;

export interface UndoStackAPI {
  push: (entry: Omit<UndoEntry, 'id' | 'timestamp'>) => void;
  undoLast: () => void;
}

export const UndoStackContext = createContext<UndoStackAPI | null>(null);

export function useUndoStack(): UndoStackAPI {
  const ctx = useContext(UndoStackContext);
  if (!ctx) throw new Error('useUndoStack must be used within UndoStackProvider');
  return ctx;
}

export function useUndoStackState(): UndoStackAPI {
  const stackRef = useRef<UndoEntry[]>([]);
  const toastIdsRef = useRef<Map<string, string | number>>(new Map());

  const undoEntry = useCallback(async (entry: UndoEntry) => {
    stackRef.current = stackRef.current.filter(e => e.id !== entry.id);
    const toastId = toastIdsRef.current.get(entry.id);
    if (toastId) {
      toast.dismiss(toastId);
      toastIdsRef.current.delete(entry.id);
    }
    try {
      await entry.undo();
      toast.success(i18n.t('undo.restored'));
    } catch (err) {
      console.error('[LIVO] Undo failed:', err);
      toast.error(i18n.t('undo.failed'));
    }
  }, []);

  const push = useCallback((entry: Omit<UndoEntry, 'id' | 'timestamp'>) => {
    const id = randomUUID();
    const full: UndoEntry = { ...entry, id, timestamp: Date.now() };
    stackRef.current = [full, ...stackRef.current].slice(0, MAX_STACK);

    const toastId = toast(entry.description, {
      duration: TOAST_DURATION,
      action: {
        label: i18n.t('undo.action'),
        onClick: () => undoEntry(full),
      },
      onDismiss: () => {
        toastIdsRef.current.delete(id);
        stackRef.current = stackRef.current.filter(e => e.id !== id);
      },
    });
    toastIdsRef.current.set(id, toastId);
  }, [undoEntry]);

  const undoLast = useCallback(() => {
    const last = stackRef.current[0];
    if (last) undoEntry(last);
  }, [undoEntry]);

  return { push, undoLast };
}
