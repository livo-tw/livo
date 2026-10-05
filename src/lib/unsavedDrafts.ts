import { useEffect, useRef } from 'react';

/**
 * Unsaved text the user would lose by navigating away. A knowledge page draft
 * lives in its view ('view'); a task's rich-text edit lives in the open task
 * ('task'). Changing the view asks about 'view' drafts, opening another task
 * or closing it asks about 'task' drafts. QA and release writes keep their own
 * guards, which block instead of asking.
 */
export type UnsavedDraftScope = 'view' | 'task';
interface Draft { scope: UnsavedDraftScope; message: () => string }

const drafts = new Map<symbol, Draft>();
// One answer covers every check made by the same click (a sidebar entry both closes the task and changes the view).
let approved = false;

export function hasUnsavedDraft(scope?: UnsavedDraftScope): boolean {
  return [...drafts.values()].some(draft => !scope || draft.scope === scope);
}

/** True when nothing would be lost, or the user agreed to discard it. */
export function confirmDiscardDrafts(scope: UnsavedDraftScope): boolean {
  if (approved) return true;
  const draft = [...drafts.values()].find(item => item.scope === scope);
  if (!draft) return true;
  if (!window.confirm(draft.message())) return false;
  approved = true;
  setTimeout(() => { approved = false; }, 0);
  return true;
}

/** Registers unsaved text while `active`; the message is read when the user is asked. */
export function useUnsavedDraft(scope: UnsavedDraftScope, active: boolean, message: string) {
  const text = useRef(message); text.current = message;
  useEffect(() => {
    if (!active) return;
    const key = Symbol(scope);
    drafts.set(key, { scope, message: () => text.current });
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => { drafts.delete(key); window.removeEventListener('beforeunload', warn); };
  }, [scope, active]);
}

/** Test helper: forget every registration. */
export function resetUnsavedDrafts() { drafts.clear(); approved = false; }
