import { useCallback } from 'react';
import i18n from '@/i18n';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { toast } from 'sonner';
import type { CustomField, TaskCustomFieldValue, TaskTemplate, TaskDependency } from '@/types';

interface TaskRelationsDeps {
  taskDependencies: TaskDependency[];
  setTaskDependencies: React.Dispatch<React.SetStateAction<TaskDependency[]>>;
  customFieldValues: TaskCustomFieldValue[];
  setCustomFieldValues: React.Dispatch<React.SetStateAction<TaskCustomFieldValue[]>>;
  setCustomFields: React.Dispatch<React.SetStateAction<CustomField[]>>;
  setTaskTemplates: React.Dispatch<React.SetStateAction<TaskTemplate[]>>;
  refreshCustomFields: () => Promise<void>;
  refreshTaskTemplates: () => Promise<void>;
}

export function useTaskRelations({
  taskDependencies, setTaskDependencies,
  customFieldValues, setCustomFieldValues,
  setCustomFields,
  setTaskTemplates,
  refreshCustomFields, refreshTaskTemplates,
}: TaskRelationsDeps) {

  // ─── Custom Field CRUD ───

  const createCustomField = useCallback(async (field: Omit<CustomField, 'id' | 'createdAt'>): Promise<CustomField | null> => {
    const id = generateId('cf');
    const row = {
      id,
      project_id: field.projectId,
      field_name: field.fieldName,
      field_type: field.fieldType,
      options: field.options ? field.options : null,
      is_required: field.isRequired,
      default_value: field.defaultValue || null,
      sort_order: field.sortOrder,
    };
    const { error } = await supabase.from('custom_fields').insert(row as Record<string, unknown>);
    if (error) { toast.error(i18n.t('error.createFailed') + error.message); return null; }
    await refreshCustomFields();
    return { ...field, id, createdAt: new Date().toISOString() };
  }, [refreshCustomFields]);

  const updateCustomField = useCallback(async (fieldId: string, updates: Partial<CustomField>) => {
    const dbUpdates: Record<string, unknown> = {};
    if ('fieldName' in updates) dbUpdates.field_name = updates.fieldName;
    if ('fieldType' in updates) dbUpdates.field_type = updates.fieldType;
    if ('options' in updates) dbUpdates.options = updates.options ?? null;
    if ('isRequired' in updates) dbUpdates.is_required = updates.isRequired;
    if ('defaultValue' in updates) dbUpdates.default_value = updates.defaultValue || null;
    if ('sortOrder' in updates) dbUpdates.sort_order = updates.sortOrder;
    if (Object.keys(dbUpdates).length === 0) return;
    const { error } = await supabase.from('custom_fields').update(dbUpdates).eq('id', fieldId);
    if (error) { toast.error(i18n.t('error.updateFailed') + error.message); return; }
    setCustomFields(prev => prev.map(f => f.id === fieldId ? { ...f, ...updates } : f));
  }, [setCustomFields]);

  const deleteCustomField = useCallback(async (fieldId: string) => {
    const { error } = await supabase.from('custom_fields').delete().eq('id', fieldId);
    if (error) { toast.error(i18n.t('error.deleteFailed') + error.message); return; }
    setCustomFields(prev => prev.filter(f => f.id !== fieldId));
    setCustomFieldValues(prev => prev.filter(v => v.fieldId !== fieldId));
  }, [setCustomFields, setCustomFieldValues]);

  const upsertCustomFieldValue = useCallback(async (taskId: string, fieldId: string, value: Partial<TaskCustomFieldValue>) => {
    const existing = customFieldValues.find(v => v.taskId === taskId && v.fieldId === fieldId);
    const id = existing?.id || generateId('cfv');
    const row = {
      id,
      task_id: taskId,
      field_id: fieldId,
      value_text: value.valueText ?? null,
      value_number: value.valueNumber !== undefined ? value.valueNumber : null,
      value_date: value.valueDate ?? null,
      value_boolean: value.valueBoolean !== undefined ? value.valueBoolean : null,
      value_user_id: value.valueUserId ?? null,
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from('task_custom_field_values').upsert(row as Record<string, unknown>, { onConflict: 'task_id,field_id' });
    if (error) { toast.error(i18n.t('error.saveFailed') + error.message); return; }
    const mapped: TaskCustomFieldValue = { id, taskId, fieldId, ...value };
    setCustomFieldValues(prev => {
      const idx = prev.findIndex(v => v.taskId === taskId && v.fieldId === fieldId);
      if (idx >= 0) return prev.map((v, i) => i === idx ? mapped : v);
      return [...prev, mapped];
    });
  }, [customFieldValues, setCustomFieldValues]);

  // ─── Task Template CRUD ───

  const createTaskTemplate = useCallback(async (template: Omit<TaskTemplate, 'id' | 'createdAt' | 'updatedAt'>): Promise<TaskTemplate | null> => {
    const id = generateId('tmpl');
    const row = {
      id,
      project_id: template.projectId || null,
      name: template.name,
      description: template.description || '',
      default_priority: template.defaultPriority || null,
      default_tag_ids: template.defaultTagIds || [],
      default_spec_background: template.defaultSpecBackground || '',
      default_spec_requirement: template.defaultSpecRequirement || '',
      default_spec_notes: template.defaultSpecNotes || '',
      created_by: template.createdBy,
    };
    const { error } = await supabase.from('task_templates').insert(row as Record<string, unknown>);
    if (error) { toast.error(i18n.t('template.createFailed') + ': ' + error.message); return null; }
    await refreshTaskTemplates();
    return { ...template, id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  }, [refreshTaskTemplates]);

  const updateTaskTemplate = useCallback(async (templateId: string, updates: Partial<TaskTemplate>) => {
    const dbUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if ('name' in updates) dbUpdates.name = updates.name;
    if ('description' in updates) dbUpdates.description = updates.description || '';
    if ('projectId' in updates) dbUpdates.project_id = updates.projectId || null;
    if ('defaultPriority' in updates) dbUpdates.default_priority = updates.defaultPriority || null;
    if ('defaultTagIds' in updates) dbUpdates.default_tag_ids = updates.defaultTagIds || [];
    if ('defaultSpecBackground' in updates) dbUpdates.default_spec_background = updates.defaultSpecBackground || '';
    if ('defaultSpecRequirement' in updates) dbUpdates.default_spec_requirement = updates.defaultSpecRequirement || '';
    if ('defaultSpecNotes' in updates) dbUpdates.default_spec_notes = updates.defaultSpecNotes || '';
    const { error } = await supabase.from('task_templates').update(dbUpdates).eq('id', templateId);
    if (error) { toast.error(i18n.t('error.updateFailed') + error.message); return; }
    setTaskTemplates(prev => prev.map(t => t.id === templateId ? { ...t, ...updates, updatedAt: new Date().toISOString() } : t));
  }, [setTaskTemplates]);

  const deleteTaskTemplate = useCallback(async (templateId: string) => {
    const { error } = await supabase.from('task_templates').delete().eq('id', templateId);
    if (error) { toast.error(i18n.t('template.deleteFailed') + ': ' + error.message); return; }
    setTaskTemplates(prev => prev.filter(t => t.id !== templateId));
    toast.success(i18n.t('template.deleted', { name: '' }));
  }, [setTaskTemplates]);

  // ─── Task Dependency CRUD ───

  const wouldCreateCycle = useCallback((taskId: string, dependsOnTaskId: string, deps: TaskDependency[]): boolean => {
    const visited = new Set<string>();
    const queue = [dependsOnTaskId];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === taskId) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      deps.filter(d => d.taskId === current).forEach(d => {
        if (!visited.has(d.dependsOnTaskId)) {
          queue.push(d.dependsOnTaskId);
        }
      });
    }
    return false;
  }, []);

  const addTaskDependency = useCallback(async (taskId: string, dependsOnTaskId: string): Promise<boolean> => {
    if (taskId === dependsOnTaskId) {
      toast.error(i18n.t('taskDetail.dependency.selfReference'));
      return false;
    }
    if (taskDependencies.some(d => d.taskId === taskId && d.dependsOnTaskId === dependsOnTaskId)) {
      toast.error(i18n.t('taskDetail.dependency.alreadyExists'));
      return false;
    }
    if (wouldCreateCycle(taskId, dependsOnTaskId, taskDependencies)) {
      toast.error(i18n.t('taskDetail.dependency.cyclicError'));
      return false;
    }
    const id = generateId('dep');
    const { error } = await supabase.from('task_dependencies').insert({
      id,
      task_id: taskId,
      depends_on_task_id: dependsOnTaskId,
      dependency_type: 'finish_to_start',
    } as Record<string, unknown>);
    if (error) {
      toast.error(i18n.t('taskDetail.dependency.addFailed') + error.message);
      return false;
    }
    const newDep: TaskDependency = { id, taskId, dependsOnTaskId, dependencyType: 'finish_to_start', createdAt: new Date().toISOString() };
    setTaskDependencies(prev => [...prev, newDep]);
    return true;
  }, [taskDependencies, wouldCreateCycle, setTaskDependencies]);

  const removeTaskDependency = useCallback(async (dependencyId: string) => {
    const { error } = await supabase.from('task_dependencies').delete().eq('id', dependencyId);
    if (error) { toast.error(i18n.t('taskDetail.dependency.removeFailed') + error.message); return; }
    setTaskDependencies(prev => prev.filter(d => d.id !== dependencyId));
  }, [setTaskDependencies]);

  return {
    createCustomField, updateCustomField, deleteCustomField, upsertCustomFieldValue,
    createTaskTemplate, updateTaskTemplate, deleteTaskTemplate,
    wouldCreateCycle, addTaskDependency, removeTaskDependency,
  };
}
