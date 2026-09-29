import { useState, useRef, useEffect, useCallback } from 'react';
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

export const useTaskSpecs = ({ task, selectedTaskId, currentMemberId, getFieldLocker, trackPresence }: Deps) => {
  const [editingField, setEditingField] = useState<string | null>(null);
  const [editSnapshot, setEditSnapshot] = useState('');
  const lastSpecSaveAt = useRef(0);
  const [specBackground, setSpecBackground] = useState('');
  const [specRequirement, setSpecRequirement] = useState('');
  const [specNotes, setSpecNotes] = useState('');

  const loadSpecFromDb = async (taskId: string) => {
    const { data, error } = await supabase
      .from('task_specs')
      .select('*')
      .eq('task_id', taskId)
      .maybeSingle();
    if (error) { console.error('loadSpecFromDb error:', error); return; }
    if (data) {
      setSpecBackground(data.background || '');
      setSpecRequirement(data.requirement || '');
      setSpecNotes(data.notes || '');
    } else {
      setSpecBackground('');
      setSpecRequirement('');
      setSpecNotes('');
    }
  };

  // Subscribe to spec realtime changes
  useEffect(() => {
    if (!selectedTaskId) return;
    const taskId = selectedTaskId;
    const channel = supabase
      .channel(`task-spec-detail-${taskId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'task_specs', filter: `task_id=eq.${taskId}` }, () => {
        if (Date.now() - lastSpecSaveAt.current < 3000) return;
        loadSpecFromDb(taskId);
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [selectedTaskId]);

  // Reset and reload when task changes
  useEffect(() => {
    if (selectedTaskId) {
      setEditingField(null);
      loadSpecFromDb(selectedTaskId);
    }
  }, [selectedTaskId]);

  const handleSpecMention = useCallback((userId: string) => {
    if (task) {
      createNotification(userId, currentMemberId, 'mention', task.id, task.title);
    }
  }, [task?.id, task?.title, currentMemberId]);

  const richFieldStartEdit = (fieldKey: string, value: string) => {
    const locker = getFieldLocker(fieldKey);
    if (locker) { toast.error(i18n.t('error.fieldBeingEdited', { name: locker.name })); return; }
    setEditingField(fieldKey);
    setEditSnapshot(value);
    trackPresence({ editingField: fieldKey });
  };

  const richFieldConfirm = async (onChange: (v: string) => void, draft: string) => {
    onChange(draft);
    if (task) {
      const bg    = editingField === i18n.t('taskDetail.spec.background')    ? draft : specBackground;
      const req   = editingField === i18n.t('taskDetail.spec.requirement') ? draft : specRequirement;
      const notes = editingField === i18n.t('taskDetail.spec.notes')    ? draft : specNotes;
      lastSpecSaveAt.current = Date.now();
      const { data: existing } = await supabase.from('task_specs').select('id').eq('task_id', task.id).maybeSingle();
      let error;
      if (existing) {
        const result = await supabase.from('task_specs').update({ background: bg, requirement: req, notes }).eq('task_id', task.id);
        error = result.error;
      } else {
        const result = await supabase.from('task_specs').insert({ id: generateId('ts'), task_id: task.id, background: bg, requirement: req, notes });
        error = result.error;
      }
      if (error) {
        console.error('Save spec error:', error);
        toast.error(i18n.t('taskDetail.spec.saveFailed') + error.message);
      } else {
        logActivity(currentMemberId, 'update_spec', `${i18n.t('activity.updateSpec')}`, task.id, task.taskKey);
        toast.success(i18n.t('taskDetail.spec.saved'));
      }
    }
    setEditingField(null);
    trackPresence({ editingField: null });
  };

  const richFieldCancel = (onChange: (v: string) => void) => {
    onChange(editSnapshot);
    setEditingField(null);
    trackPresence({ editingField: null });
  };

  return {
    editingField,
    editSnapshot,
    specBackground, setSpecBackground,
    specRequirement, setSpecRequirement,
    specNotes, setSpecNotes,
    loadSpecFromDb,
    handleSpecMention,
    richFieldStartEdit,
    richFieldConfirm,
    richFieldCancel,
  };
};
