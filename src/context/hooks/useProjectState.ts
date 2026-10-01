import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import i18n from '@/i18n';
import { logActivity } from '@/lib/activityLog';
import type { Project, ProductLine, Task } from '@/types';
import { mapProductLine, mapProject } from '../mappers';

export function useProjectState() {
  const [allProjects, setAllProjects] = useState<Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedLineId, setSelectedLineId] = useState<string | null>(null);
  const [productLines, setProductLines] = useState<ProductLine[]>([]);

  const refreshProductLines = useCallback(async () => {
    const { data } = await supabase.from('product_lines').select('*').order('sort_order');
    if (data) setProductLines(data.map(mapProductLine));
  }, []);

  const refreshProjects = useCallback(async () => {
    const { data } = await supabase.from('projects').select('*');
    if (data) setAllProjects(data.map(mapProject));
  }, []);

  // ─── Product Line CRUD ───
  const createProductLineInDb = useCallback(async (line: ProductLine) => {
    const { error } = await supabase.from('product_lines').insert({
      id: line.id, name: line.name, icon: line.icon, color: line.color, sort_order: line.sortOrder,
    });
    if (error) { toast.error(i18n.t('productLine.createFailed')); return; }
    setProductLines(prev => [...prev, line]);
    toast.success(i18n.t('productLine.created'));
  }, []);

  const updateProductLineInDb = useCallback(async (lineId: string, updates: Partial<ProductLine>) => {
    const dbUpdates: Record<string, string | number | boolean> = {};
    if (updates.name !== undefined) dbUpdates.name = updates.name;
    if (updates.icon !== undefined) dbUpdates.icon = updates.icon;
    if (updates.color !== undefined) dbUpdates.color = updates.color;
    if (updates.sortOrder !== undefined) dbUpdates.sort_order = updates.sortOrder;
    const { error } = await supabase.from('product_lines').update(dbUpdates).eq('id', lineId);
    if (error) { toast.error(i18n.t('productLine.updateFailed')); return; }
    setProductLines(prev => prev.map(l => l.id === lineId ? { ...l, ...updates } : l));
    toast.success(i18n.t('productLine.updated'));
  }, []);

  const deleteProductLineInDb = useCallback(async (lineId: string): Promise<boolean> => {
    const { data: linkedProjects } = await supabase.from('projects').select('id').eq('line_id', lineId).limit(1);
    if (linkedProjects && linkedProjects.length > 0) {
      toast.error(i18n.t('productLine.hasProjects'));
      return false;
    }
    const { error } = await supabase.from('product_lines').delete().eq('id', lineId);
    if (error) { toast.error(i18n.t('productLine.deleteFailed')); return false; }
    setProductLines(prev => prev.filter(l => l.id !== lineId));
    toast.success(i18n.t('productLine.deleted'));
    return true;
  }, []);

  // ─── Project CRUD ───
  /** Returns the error message when the insert fails, null on success. */
  const createProjectInDb = useCallback(async (project: Project): Promise<string | null> => {
    const { error } = await supabase.from('projects').insert({
      id: project.id, line_id: project.lineId, name: project.name,
      key: project.key, color: project.color, is_archived: project.isArchived,
    });
    if (error) {
      toast.error(i18n.t('project.createFailed') + error.message);
      return error.message;
    }
    setAllProjects(prev => prev.some(p => p.id === project.id) ? prev : [...prev, project]);
    return null;
  }, []);

  const updateProjectInDb = useCallback(async (projectId: string, updates: Partial<Project>) => {
    const dbUpdates: Record<string, unknown> = {};
    if ('name' in updates) dbUpdates.name = updates.name;
    if ('lineId' in updates) dbUpdates.line_id = updates.lineId;
    if ('color' in updates) dbUpdates.color = updates.color;
    if ('key' in updates) dbUpdates.key = updates.key;
    if ('isArchived' in updates) dbUpdates.is_archived = updates.isArchived;
    if (Object.keys(dbUpdates).length > 0) {
      const { error } = await supabase.from('projects').update(dbUpdates).eq('id', projectId);
      if (error) {
        toast.error(i18n.t('project.updateFailed') + error.message);
      } else {
        setAllProjects(prev => prev.map(p => p.id === projectId ? { ...p, ...updates } : p));
      }
    }
  }, []);

  const createDeleteProjectInDb = useCallback(
    (allTasks: Task[], currentMemberId: string, setAllTasks: (fn: (prev: Task[]) => Task[]) => void) =>
      async (projectId: string) => {
        const projectTasks = allTasks.filter(t => t.projectId === projectId);
        const taskIds = projectTasks.map(t => t.id);
        if (taskIds.length > 0) {
          await supabase.from('comments').delete().in('task_id', taskIds);
          await supabase.from('task_checks').delete().in('task_id', taskIds);
          await supabase.from('task_todos').delete().in('task_id', taskIds);
          await supabase.from('task_specs').delete().in('task_id', taskIds);
          await supabase.from('task_deployments').delete().in('task_id', taskIds);
          await supabase.from('task_attachments').delete().in('task_id', taskIds);
          await supabase.from('task_dependencies').delete().in('task_id', taskIds);
          await supabase.from('task_dependencies').delete().in('depends_on_task_id', taskIds);
          await supabase.from('status_logs').delete().in('task_id', taskIds);
          await supabase.from('tasks').delete().in('id', taskIds);
        }
        const { error } = await supabase.from('projects').delete().eq('id', projectId);
        if (error) {
          toast.error(i18n.t('project.deleteFailed') + error.message);
        } else {
          const deletedProject = allProjects.find(p => p.id === projectId);
          setAllProjects(prev => prev.filter(p => p.id !== projectId));
          setAllTasks(prev => prev.filter(t => t.projectId !== projectId));
          if (selectedProjectId === projectId) setSelectedProjectId(null);
          toast.success(i18n.t('project.deleted'));
          if (currentMemberId && deletedProject) {
            await logActivity(currentMemberId, 'delete_project', i18n.t('activity.deleteProject', { name: deletedProject.name, key: deletedProject.key }), undefined, undefined, 'project');
          }
        }
      },
    [allProjects, selectedProjectId],
  );

  return {
    allProjects, setAllProjects,
    selectedProjectId, setSelectedProjectId,
    selectedLineId, setSelectedLineId,
    productLines, setProductLines,
    refreshProductLines, refreshProjects,
    createProductLineInDb, updateProductLineInDb, deleteProductLineInDb,
    createProjectInDb, updateProjectInDb, createDeleteProjectInDb,
  };
}
