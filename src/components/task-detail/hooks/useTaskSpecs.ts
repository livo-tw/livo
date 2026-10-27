import { useState, useRef, useEffect, useCallback, useSyncExternalStore, type SetStateAction } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { logActivity } from '@/lib/activityLog';
import { createNotification } from '../utils';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task } from '@/types';
import type { OtherViewer } from './types';

type Deps = {
  task: Task | null;
  selectedTaskId: string | undefined;
  currentMemberId: string;
  getFieldLocker: (fieldKey: string) => OtherViewer | undefined;
  trackPresence: (extra?: Record<string, unknown>) => Promise<void>;
};
type SpecField = 'background' | 'requirement' | 'notes';
type SpecState = { scope: string; status: 'loading' | 'ready' | 'error'; background: string; requirement: string; notes: string };
// A request may outlive a detail component. Keep only its owner key here,
// so reopening the same task waits for that write before starting another one.
const pendingSpecSaves = new Set<string>();
const saveListeners = new Set<() => void>();
const subscribeToSpecSaves = (listener: () => void) => {
  saveListeners.add(listener);
  return () => { saveListeners.delete(listener); };
};
const notifySpecSaves = () => { for (const listener of [...saveListeners]) listener(); };
const emptySpec = (scope: string): SpecState => ({ scope, status: 'loading', background: '', requirement: '', notes: '' });

export const useTaskSpecs = ({ task, selectedTaskId, currentMemberId, getFieldLocker, trackPresence }: Deps) => {
  const owner = `${currentMemberId}:${selectedTaskId || ''}`;
  const visit = useRef({ owner, generation: 0 });
  if (visit.current.owner !== owner) visit.current = { owner, generation: visit.current.generation + 1 };
  const scope = `${owner}:${visit.current.generation}`;
  const activeScope = useRef(scope); activeScope.current = scope;
  const request = useRef(0);
  const specSaving = useSyncExternalStore(subscribeToSpecSaves, () => pendingSpecSaves.has(owner), () => false);
  const previousSave = useRef({ owner, saving: specSaving });
  const [spec, setSpec] = useState<SpecState>(() => emptySpec(scope));
  const current = spec.scope === scope ? spec : emptySpec(scope);
  const [editing, setEditing] = useState<{ scope: string; field: string; snapshot: string } | null>(null);
  const activeEditing = useRef<string | null>(null);
  activeEditing.current = editing?.scope === scope ? editing.field : null;
  const lastSpecSaveAt = useRef(0);

  const setField = (field: SpecField, next: SetStateAction<string>) => {
    if (activeScope.current !== scope) return;
    setSpec(previous => previous.scope === scope ? { ...previous, [field]: typeof next === 'function' ? next(previous[field]) : next } : previous);
  };

  const loadSpecFromDb = useCallback(async (taskId: string) => {
    if (activeScope.current !== scope || taskId !== selectedTaskId) return;
    const sequence = ++request.current;
    try {
      const { data, error } = await supabase.from('task_specs').select('*').eq('task_id', taskId).maybeSingle();
      if (activeScope.current !== scope || sequence !== request.current || activeEditing.current || pendingSpecSaves.has(owner)) return;
      if (error) throw error;
      setSpec({ scope, status: 'ready', background: data?.background || '', requirement: data?.requirement || '', notes: data?.notes || '' });
    } catch (error) {
      if (activeScope.current !== scope || sequence !== request.current || activeEditing.current) return;
      console.error('loadSpecFromDb error:', error);
      setSpec(previous => ({ ...(previous.scope === scope ? previous : emptySpec(scope)), status: 'error' }));
    }
  }, [scope, owner, selectedTaskId]);

  useEffect(() => {
    activeScope.current = scope;
    setEditing(null); lastSpecSaveAt.current = 0;
    if (selectedTaskId && !pendingSpecSaves.has(owner)) void loadSpecFromDb(selectedTaskId);
    return () => { request.current++; if (activeScope.current === scope) activeScope.current = ''; };
  }, [scope, owner, selectedTaskId, loadSpecFromDb]);

  useEffect(() => {
    const finished = previousSave.current.owner === owner && previousSave.current.saving && !specSaving;
    previousSave.current = { owner, saving: specSaving };
    if (finished && selectedTaskId && !activeEditing.current) void loadSpecFromDb(selectedTaskId);
  }, [owner, scope, specSaving, selectedTaskId, loadSpecFromDb]);

  useEffect(() => {
    if (!selectedTaskId) return;
    const channel = supabase.channel(`task-spec-detail-${selectedTaskId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_specs', filter: `task_id=eq.${selectedTaskId}` }, () => {
        if (Date.now() - lastSpecSaveAt.current < 3000) return;
        void loadSpecFromDb(selectedTaskId);
      }).subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedTaskId, scope, loadSpecFromDb]);

  const handleSpecMention = useCallback((userId: string) => {
    if (task && activeScope.current === scope) createNotification(userId, currentMemberId, 'mention', task.id, task.title);
  }, [task?.id, task?.title, currentMemberId, scope]);

  const richFieldStartEdit = (fieldKey: string, value: string) => {
    if (activeScope.current !== scope || current.status !== 'ready' || pendingSpecSaves.has(owner)) return;
    const locker = getFieldLocker(fieldKey);
    if (locker) { toast.error(i18n.t('error.fieldBeingEdited', { name: locker.name })); return; }
    activeEditing.current = fieldKey;
    setEditing({ scope, field: fieldKey, snapshot: value });
    void trackPresence({ editingField: fieldKey });
  };

  const richFieldConfirm = async (onChange: (value: string) => void, draft: string) => {
    const field = (['background', 'requirement', 'notes'] as const).find(key => i18n.t(`taskDetail.spec.${key}`) === editing?.field);
    const target = task;
    if (!target || target.id !== selectedTaskId || editing?.scope !== scope || !field || current.status !== 'ready' || pendingSpecSaves.has(owner) || activeScope.current !== scope) return;
    pendingSpecSaves.add(owner); notifySpecSaves();
    try {
      const existing = await supabase.from('task_specs').select('id').eq('task_id', target.id).maybeSingle();
      if (activeScope.current !== scope) return;
      if (existing.error) throw existing.error;
      // Write only the edited field: another field may have changed since this editor opened.
      const patch = { [field]: draft };
      lastSpecSaveAt.current = Date.now();
      const result = existing.data
        ? await supabase.from('task_specs').update(patch).eq('task_id', target.id)
        : await supabase.from('task_specs').insert({ id: generateId('ts'), task_id: target.id, ...patch });
      if (result.error) throw result.error;
      if (activeScope.current !== scope) return;
      onChange(draft);
      activeEditing.current = null; setEditing(null);
      void trackPresence({ editingField: null });
      void logActivity(currentMemberId, 'update_spec', i18n.t('activity.updateSpec'), target.id, target.taskKey);
      toast.success(i18n.t('taskDetail.spec.saved'));
    } catch (error) {
      if (activeScope.current === scope) {
        const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '';
        toast.error(i18n.t('taskDetail.spec.saveFailed') + message);
      }
    } finally {
      pendingSpecSaves.delete(owner); notifySpecSaves();
    }
  };

  const richFieldCancel = (onChange: (value: string) => void) => {
    if (editing?.scope !== scope || pendingSpecSaves.has(owner)) return;
    onChange(editing.snapshot);
    activeEditing.current = null; setEditing(null);
    void trackPresence({ editingField: null });
    if (selectedTaskId) void loadSpecFromDb(selectedTaskId);
  };

  return {
    editingField: editing?.scope === scope ? editing.field : null,
    editSnapshot: editing?.scope === scope ? editing.snapshot : '',
    specBackground: current.background, setSpecBackground: (next: SetStateAction<string>) => setField('background', next),
    specRequirement: current.requirement, setSpecRequirement: (next: SetStateAction<string>) => setField('requirement', next),
    specNotes: current.notes, setSpecNotes: (next: SetStateAction<string>) => setField('notes', next),
    specLoading: current.status === 'loading', specLoadError: current.status === 'error', specSaving,
    loadSpecFromDb, handleSpecMention, richFieldStartEdit, richFieldConfirm, richFieldCancel,
  };
};
