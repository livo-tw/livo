import { useState, useRef, useEffect } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { generateId } from '@/lib/generateId';
import { logActivity } from '@/lib/activityLog';
import { toast } from 'sonner';
import i18n from '@/i18n';
import type { Task, User, Tag } from '@/types';
import type { OtherViewer } from './types';

type ConfirmFn = (opts: { title: string; description: string; destructive?: boolean }) => Promise<boolean>;

type Deps = {
  task: Task | null;
  currentMemberId: string;
  users: User[];
  tags: Tag[];
  allTasks: Task[];
  setAllTasks: (tasks: Task[]) => void;
  setSelectedTask: (task: Task | null) => void;
  refreshTags: () => Promise<void>;
  getFieldLocker: (fieldKey: string) => OtherViewer | undefined;
  trackPresence: (extra?: Record<string, unknown>) => Promise<void>;
  confirm: ConfirmFn;
};

const SIDEBAR_DEFAULT_ORDER = [
  'project', 'status', 'priority', 'assignee', 'department', 'reviewer',
  'tags', 'dependencies', 'creator', 'startDate', 'dueDate', 'completedDate',
  'deployments', 'gitlabMR', 'customFields',
];

export const useTaskSidebarFields = ({
  task, currentMemberId, users, tags, allTasks, setAllTasks, setSelectedTask,
  refreshTags, getFieldLocker, trackPresence, confirm,
}: Deps) => {
  // ── Sidebar layout ──────────────────────────────────────────────────────
  const [sidebarFieldOrder, setSidebarFieldOrder] = useState<string[]>([]);
  const [isLayoutMode, setIsLayoutMode] = useState(false);
  const [dragFieldIdx, setDragFieldIdx] = useState<number | null>(null);
  const [dragOverFieldIdx, setDragOverFieldIdx] = useState<number | null>(null);
  const [layoutSaving, setLayoutSaving] = useState(false);

  // ── Status dropdown ─────────────────────────────────────────────────────
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const statusDropdownRef = useRef<HTMLDivElement>(null);

  // ── Tag dropdown ────────────────────────────────────────────────────────
  const [tagDropdownOpen, setTagDropdownOpen] = useState(false);
  const tagDropdownRef = useRef<HTMLDivElement>(null);
  const tagDropdownOpenRef = useRef(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#6554C0');
  const [tagManageMode, setTagManageMode] = useState(false);

  // ── Dependency dropdown ─────────────────────────────────────────────────
  const [depSearchQuery, setDepSearchQuery] = useState('');
  const [depDropdownOpen, setDepDropdownOpen] = useState(false);
  const depDropdownRef = useRef<HTMLDivElement>(null);

  // ── Subtask state ───────────────────────────────────────────────────────
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('');
  const [addingSubtask, setAddingSubtask] = useState(false);
  const subtaskInputRef = useRef<HTMLInputElement>(null);
  const [subtaskStatusPickerId, setSubtaskStatusPickerId] = useState<string | null>(null);
  const subtaskStatusPickerIdRef = useRef<string | null>(null);

  // Sync refs
  useEffect(() => { tagDropdownOpenRef.current = tagDropdownOpen; }, [tagDropdownOpen]);
  useEffect(() => { subtaskStatusPickerIdRef.current = subtaskStatusPickerId; }, [subtaskStatusPickerId]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node))
        setStatusDropdownOpen(false);
      if (depDropdownRef.current && !depDropdownRef.current.contains(e.target as Node)) {
        setDepDropdownOpen(false);
        setDepSearchQuery('');
      }
      if (tagDropdownOpenRef.current && tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node)) {
        setTagDropdownOpen(false);
        trackPresence({ editingField: null });
      }
      if (subtaskStatusPickerIdRef.current && !(e.target as Element).closest('[data-subtask-status-picker]')) {
        setSubtaskStatusPickerId(null);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [trackPresence]);

  // Load sidebar field order
  useEffect(() => {
    supabase.from('team_settings').select('value').eq('key', 'sidebar_field_order').maybeSingle()
      .then(({ data }) => {
        setSidebarFieldOrder(
          data?.value && Array.isArray(data.value) ? (data.value as string[]) : SIDEBAR_DEFAULT_ORDER
        );
      });
  }, []);

  // ── Sidebar layout handlers ─────────────────────────────────────────────
  const saveSidebarFieldOrder = async () => {
    setLayoutSaving(true);
    await supabase.from('team_settings').upsert({
      key: 'sidebar_field_order',
      value: sidebarFieldOrder as unknown,
      updated_by: currentMemberId,
      updated_at: new Date().toISOString(),
    } as Record<string, unknown>);
    setIsLayoutMode(false);
    setLayoutSaving(false);
    toast.success(i18n.t('taskDetail.sidebar.layoutSaved'));
  };

  const handleFieldDragStart = (e: React.DragEvent, idx: number) => {
    setDragFieldIdx(idx);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleFieldDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverFieldIdx(idx);
  };

  const handleFieldDrop = () => {
    if (dragFieldIdx === null || dragOverFieldIdx === null || dragFieldIdx === dragOverFieldIdx) {
      setDragFieldIdx(null);
      setDragOverFieldIdx(null);
      return;
    }
    const newOrder = [...sidebarFieldOrder];
    const [moved] = newOrder.splice(dragFieldIdx, 1);
    newOrder.splice(dragOverFieldIdx, 0, moved);
    setSidebarFieldOrder(newOrder);
    setDragFieldIdx(null);
    setDragOverFieldIdx(null);
  };

  // ── Tag helpers ─────────────────────────────────────────────────────────
  const tagFieldLocker = getFieldLocker('tags');
  const isTagLocked = !!tagFieldLocker;

  const openTagDropdown = () => {
    const locker = getFieldLocker('tags');
    if (locker) { toast.error(i18n.t('taskDetail.sidebar.tagBeingEditedError', { name: locker.name })); return; }
    setTagDropdownOpen(true);
    trackPresence({ editingField: 'tags' });
  };

  const closeTagDropdown = () => {
    setTagDropdownOpen(false);
    trackPresence({ editingField: null });
  };

  const addTag = async (tagId: string) => {
    if (!task || isTagLocked) return;
    const currentTagIds = task.tagIds || [];
    if (currentTagIds.includes(tagId)) return;
    const newTagIds = [...currentTagIds, tagId];
    const prev = { ...task };
    const updated = { ...task, tagIds: newTagIds };
    setAllTasks(prev2 => prev2.map(t => t.id === task.id ? updated : t));
    setSelectedTask(updated);
    const { error } = await supabase.from('task_tags').insert({ id: generateId('tt'), task_id: task.id, tag_id: tagId });
    if (error) {
      setAllTasks(prev2 => prev2.map(t => t.id === task.id ? prev : t));
      setSelectedTask(prev);
      toast.error(i18n.t('taskDetail.sidebar.addTagFailed') + error.message);
      return;
    }
    closeTagDropdown();
    logActivity(currentMemberId, 'add_tag', tags.find(t => t.id === tagId)?.name || tagId, task.id, task.taskKey);
  };

  const removeTag = async (tagId: string) => {
    if (!task || isTagLocked) return;
    const newTagIds = (task.tagIds || []).filter(id => id !== tagId);
    const prev = { ...task };
    const updated = { ...task, tagIds: newTagIds.length > 0 ? newTagIds : undefined };
    setAllTasks(prev2 => prev2.map(t => t.id === task.id ? updated : t));
    setSelectedTask(updated);
    const { error } = await supabase.from('task_tags').delete().eq('task_id', task.id).eq('tag_id', tagId);
    if (error) {
      setAllTasks(prev2 => prev2.map(t => t.id === task.id ? prev : t));
      setSelectedTask(prev);
      toast.error(i18n.t('taskDetail.sidebar.removeTagFailed') + error.message);
      return;
    }
    logActivity(currentMemberId, 'remove_tag', tags.find(t => t.id === tagId)?.name || tagId, task.id, task.taskKey);
  };

  const createTag = async () => {
    if (isTagLocked) return;
    const name = newTagName.trim();
    if (!name) return;
    if (tags.find(t => t.name === name)) { toast.error(i18n.t('error.tagNameExists')); return; }
    const newTag = { id: generateId('tag'), name, color: newTagColor };
    const { error } = await supabase.from('tags').insert(newTag);
    if (error) { toast.error(i18n.t('taskDetail.sidebar.createTagFailed') + error.message); return; }
    await refreshTags();
    setNewTagName('');
    toast.success(i18n.t('taskDetail.sidebar.tagCreated', { name }));
  };

  const deleteTag = async (tagId: string) => {
    if (!task || isTagLocked) return;
    const tag = tags.find(t => t.id === tagId);
    if (!tag) return;
    if (!(await confirm({ description: i18n.t('taskDetail.sidebar.deleteTagConfirm', { name: tag.name }), title: i18n.t('button.confirmDelete'), destructive: true }))) return;
    const { error: err1 } = await supabase.from('task_tags').delete().eq('tag_id', tagId);
    if (err1) { toast.error(i18n.t('taskDetail.sidebar.deleteTagRelationsFailed') + err1.message); return; }
    const { error: err2 } = await supabase.from('tags').delete().eq('id', tagId);
    if (err2) { toast.error(i18n.t('taskDetail.sidebar.deleteTagFailed') + err2.message); return; }
    await refreshTags();
    if (task.tagIds?.includes(tagId)) {
      const newTagIds = task.tagIds.filter(id => id !== tagId);
      const updated = { ...task, tagIds: newTagIds.length > 0 ? newTagIds : undefined };
      setAllTasks(prev2 => prev2.map(t => t.id === task.id ? updated : t));
      setSelectedTask(updated);
    }
    logActivity(currentMemberId, 'delete_tag', i18n.t('taskDetail.sidebar.tagDeleted', { name: tag.name }), task.id, task.taskKey);
    toast.success(i18n.t('taskDetail.sidebar.tagDeleted', { name: tag.name }));
  };

  return {
    // Sidebar layout
    sidebarFieldOrder, setSidebarFieldOrder,
    isLayoutMode, setIsLayoutMode,
    dragFieldIdx, dragOverFieldIdx,
    layoutSaving,
    SIDEBAR_DEFAULT_ORDER,
    saveSidebarFieldOrder,
    handleFieldDragStart, handleFieldDragOver, handleFieldDrop,

    // Status dropdown
    statusDropdownOpen, setStatusDropdownOpen, statusDropdownRef,

    // Tag dropdown
    tagDropdownOpen, tagDropdownRef,
    tagFieldLocker, isTagLocked,
    newTagName, setNewTagName,
    newTagColor, setNewTagColor,
    tagManageMode, setTagManageMode,
    openTagDropdown, closeTagDropdown,
    addTag, removeTag, createTag, deleteTag,

    // Dependency dropdown
    depSearchQuery, setDepSearchQuery,
    depDropdownOpen, setDepDropdownOpen, depDropdownRef,

    // Subtask input state
    newSubtaskTitle, setNewSubtaskTitle,
    addingSubtask, setAddingSubtask,
    subtaskInputRef,
    subtaskStatusPickerId, setSubtaskStatusPickerId,
  };
};
