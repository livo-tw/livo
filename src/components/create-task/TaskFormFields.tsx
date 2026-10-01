import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { generateId } from '@/lib/generateId';
import { CalendarIcon, ChevronDown, Rocket, X } from 'lucide-react';
import UserSelect from '@/components/UserSelect';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { Priority, Tag, TaskDeployment, Status } from '@/types';
import { projectGroupLabel, type ProjectGroup } from '@/lib/projectGroups';

const envList = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'] as const;
type EnvName = typeof envList[number];

const priorities: { value: Priority; label: string; color: string }[] = [
  { value: 'highest', label: 'Highest', color: '#FF5630' },
  { value: 'high',    label: 'High',    color: '#FF8B00' },
  { value: 'medium',  label: 'Medium',  color: '#FFAB00' },
  { value: 'low',     label: 'Low',     color: '#0065FF' },
  { value: 'lowest',  label: 'Lowest',  color: '#6B778C' },
];

export interface TaskFormFieldsProps {
  projectId: string;
  setProjectId: (id: string) => void;
  statusId: string;
  setStatusId: (id: string) => void;
  priority: Priority;
  setPriority: (p: Priority) => void;
  assigneeId: string;
  setAssigneeId: (id: string) => void;
  reviewerId: string;
  setReviewerId: (id: string) => void;
  startDate: Date | undefined;
  setStartDate: (d: Date | undefined) => void;
  dueDate: Date | undefined;
  setDueDate: (d: Date | undefined) => void;
  gitlabUrl: string;
  setGitlabUrl: (url: string) => void;
  deployments: TaskDeployment[];
  setDeployments: (d: TaskDeployment[] | ((prev: TaskDeployment[]) => TaskDeployment[])) => void;
  selectedTagIds: string[];
  setSelectedTagIds: (ids: string[] | ((prev: string[]) => string[])) => void;
  tags: Tag[];
  refreshTags: () => Promise<void>;
  showValidationErrors: boolean;
  setShowValidationErrors: (v: boolean) => void;
  requiredFields: Record<string, boolean>;
  groupedProjects: ProjectGroup[];
  statuses: Status[];
  // Tag picker state
  tagPickerOpen: boolean;
  setTagPickerOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  tagPickerRef: React.RefObject<HTMLDivElement>;
  newTagName: string;
  setNewTagName: (v: string) => void;
  newTagColor: string;
  setNewTagColor: (v: string) => void;
  tagManageMode: boolean;
  setTagManageMode: (v: boolean | ((prev: boolean) => boolean)) => void;
  confirm: (opts: { title: string; description: string; destructive?: boolean }) => Promise<boolean>;
  hideDeployment?: boolean;
}

const TaskFormFields = ({
  projectId, setProjectId, statusId, setStatusId, priority, setPriority,
  assigneeId, setAssigneeId, reviewerId, setReviewerId,
  startDate, setStartDate, dueDate, setDueDate,
  gitlabUrl, setGitlabUrl, deployments, setDeployments,
  selectedTagIds, setSelectedTagIds, tags, refreshTags,
  showValidationErrors, setShowValidationErrors, requiredFields,
  groupedProjects, statuses,
  tagPickerOpen, setTagPickerOpen, tagPickerRef,
  newTagName, setNewTagName, newTagColor, setNewTagColor,
  tagManageMode, setTagManageMode, confirm,
  hideDeployment,
}: TaskFormFieldsProps) => {
  const { t } = useTranslation();
  const toggleDeploy = (env: EnvName) => {
    const exists = deployments.find(d => d.environment === env);
    if (exists) {
      setDeployments(prev => prev.filter(d => d.environment !== env));
    } else {
      setDeployments(prev => [...prev, { environment: env, status: 'scheduled', deployDate: undefined }]);
    }
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.projectLabel')}</label>
        <select value={projectId} onChange={e => setProjectId(e.target.value)}
          className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
          {groupedProjects.map(g => (
            <optgroup key={g.line?.id ?? 'other'} label={projectGroupLabel(g.line, t('common.other'))}>
              {g.projects.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.statusLabel')}{requiredFields.status && <span className="text-destructive"> *</span>}</label>
        <select value={statusId} onChange={e => setStatusId(e.target.value)}
          className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
          {statuses.map(s => (<option key={s.id} value={s.id}>{s.name}</option>))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.priorityLabel')}{requiredFields.priority && <span className="text-destructive"> *</span>}</label>
        <select value={priority} onChange={e => setPriority(e.target.value as Priority)}
          className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
          {priorities.map(p => (<option key={p.value} value={p.value}>{p.label}</option>))}
        </select>
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.assigneeLabel')}{requiredFields.assignee && <span className="text-destructive"> *</span>}</label>
        <UserSelect value={assigneeId} onChange={setAssigneeId} allowEmpty emptyLabel={t('common.unassigned')} />
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.reviewerLabel')}{requiredFields.reviewer && <span className="text-destructive"> *</span>}</label>
        <UserSelect value={reviewerId} onChange={setReviewerId} allowEmpty emptyLabel={t('common.unassigned')} />
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.startDateLabel')}{requiredFields.startDate && <span className="text-destructive"> *</span>}</label>
        <Popover>
          <PopoverTrigger asChild>
            <button className={cn("w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-left flex items-center gap-1.5 outline-none focus:ring-1 focus:ring-primary", !startDate && "text-muted-foreground/50")}>
              <CalendarIcon size={12} />
              {startDate ? format(startDate, 'yyyy-MM-dd') : t('taskCreate.selectDate')}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar mode="single" selected={startDate} onSelect={setStartDate} initialFocus className={cn("p-3 pointer-events-auto")} />
          </PopoverContent>
        </Popover>
      </div>
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.dueDateLabel')}{requiredFields.dueDate && <span className="text-destructive"> *</span>}</label>
        <Popover>
          <PopoverTrigger asChild>
            <button className={cn("w-full border rounded px-2.5 py-1.5 text-sm bg-card text-left flex items-center gap-1.5 outline-none focus:ring-1 focus:ring-primary", !dueDate && "text-muted-foreground/50", showValidationErrors && requiredFields.dueDate && !dueDate ? "border-destructive ring-1 ring-destructive/50" : "border-border")}>
              <CalendarIcon size={12} />
              {dueDate ? format(dueDate, 'yyyy-MM-dd') : t('taskCreate.selectDate')}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar mode="single" selected={dueDate} onSelect={(d) => { setDueDate(d); setShowValidationErrors(false); }} initialFocus className={cn("p-3 pointer-events-auto")} />
          </PopoverContent>
        </Popover>
      </div>

      {/* Tags */}
      <div className="relative" ref={tagPickerRef}>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.tagsLabel')}{requiredFields.tags && <span className="text-destructive"> *</span>}</label>
        <div className="flex flex-wrap gap-1.5 mb-1.5 min-h-6">
          {selectedTagIds.map(tagId => {
            const tag = tags.find(t => t.id === tagId);
            if (!tag) return null;
            return (
              <span key={tag.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-white"
                style={{ backgroundColor: tag.color }}>
                {tag.name}
                <button type="button" onClick={() => setSelectedTagIds(prev => prev.filter(id => id !== tagId))} className="hover:opacity-80">
                  <X size={12} />
                </button>
              </span>
            );
          })}
        </div>
        <button
          type="button"
          onClick={() => setTagPickerOpen(v => !v)}
          className="w-full text-xs font-medium rounded px-2 py-1.5 flex items-center justify-between border border-border bg-muted hover:bg-muted/80 transition-colors text-foreground"
        >
          <span>{t('taskCreate.selectTags')}</span>
          <ChevronDown size={12} />
        </button>
        {tagPickerOpen && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1 max-h-72 overflow-y-auto">
            <div className="flex items-center justify-between px-2.5 py-1 border-b border-border mb-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                {tagManageMode ? t('taskCreate.manageTags') : t('taskCreate.selectTags')}
              </span>
              <button type="button" onClick={() => setTagManageMode(v => !v)} className="text-[10px] text-primary hover:underline">
                {tagManageMode ? t('taskCreate.backToSelection') : t('button.manage')}
              </button>
            </div>

            {tagManageMode ? (
              <>
                {tags.map(tag => (
                  <div key={tag.id} className="flex items-center justify-between px-2.5 py-1.5 hover:bg-accent transition-colors">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                      <span className="text-xs font-medium" style={{ color: tag.color }}>{tag.name}</span>
                    </div>
                    <button type="button" onClick={async () => {
                      if (!(await confirm({ description: t('taskCreate.deleteTagConfirm', { name: tag.name }), title: t('confirm.defaultTitle'), destructive: true }))) return;
                      try {
                        await supabase.from('task_tags').delete().eq('tag_id', tag.id);
                        await supabase.from('tags').delete().eq('id', tag.id);
                        await refreshTags();
                        setSelectedTagIds(prev => prev.filter(id => id !== tag.id));
                      } catch (err: any) {
                        toast.error(t('error.operationFailed'));
                        console.error(err);
                      }
                    }} className="text-muted-foreground hover:text-destructive transition-colors">
                      <X size={12} />
                    </button>
                  </div>
                ))}
                {tags.length === 0 && <p className="text-xs text-muted-foreground px-2.5 py-1.5">{t('taskCreate.noTags')}</p>}
              </>
            ) : (
              <>
                {tags.filter(t => !selectedTagIds.includes(t.id)).map(tag => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => { setSelectedTagIds(prev => [...prev, tag.id]); setTagPickerOpen(false); }}
                    className="w-full text-left px-2.5 py-1.5 text-xs font-medium flex items-center gap-2 hover:bg-accent transition-colors"
                  >
                    <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: tag.color }} />
                    <span style={{ color: tag.color }}>{tag.name}</span>
                  </button>
                ))}
                {tags.filter(t => !selectedTagIds.includes(t.id)).length === 0 && (
                  <p className="text-xs text-muted-foreground px-2.5 py-1.5">{t('taskCreate.allTagsSelected')}</p>
                )}
              </>
            )}

            <div className="border-t border-border mt-1 px-2.5 py-2">
              <div className="flex items-center gap-1.5">
                <input type="color" value={newTagColor} onChange={e => setNewTagColor(e.target.value)}
                  className="w-5 h-5 rounded cursor-pointer border-0 p-0" />
                <input type="text" value={newTagName} onChange={e => setNewTagName(e.target.value)}
                  onKeyDown={async e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const name = newTagName.trim();
                      if (!name) return;
                      try {
                        const newTag = { id: generateId('tag'), name, color: newTagColor };
                        await supabase.from('tags').insert(newTag);
                        await refreshTags();
                        setSelectedTagIds(prev => [...prev, newTag.id]);
                        setNewTagName('');
                      } catch (err: any) {
                        toast.error(t('error.operationFailed'));
                        console.error(err);
                      }
                    }
                  }}
                  placeholder={t('taskCreate.newTagPlaceholder')}
                  className="flex-1 text-xs border border-border rounded px-2 py-1 bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary" />
                <button type="button" onClick={async () => {
                  const name = newTagName.trim();
                  if (!name) return;
                  try {
                    const newTag = { id: generateId('tag'), name, color: newTagColor };
                    await supabase.from('tags').insert(newTag);
                    await refreshTags();
                    setSelectedTagIds(prev => [...prev, newTag.id]);
                    setNewTagName('');
                  } catch (err: any) {
                    toast.error(t('error.operationFailed'));
                    console.error(err);
                  }
                }} disabled={!newTagName.trim()}
                  className="text-xs px-2 py-1 rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors">
                  {t('common.create')}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.gitlabMrLabel')}{requiredFields.gitlabUrl && <span className="text-destructive"> *</span>}</label>
        <input type="url" value={gitlabUrl} onChange={e => setGitlabUrl(e.target.value)} placeholder={t('taskCreate.gitlabMrPlaceholder')}
          className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50" />
      </div>
      {!hideDeployment && (
      <div className="border-t border-border pt-3">
        <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1"><Rocket size={16} /> {t('taskCreate.deploymentLabel')}</h3>
        <div className="space-y-2">
          {envList.map(env => {
            const dep = deployments.find(d => d.environment === env);
            const active = !!dep;
            return (
              <div key={env} className="flex items-center gap-2">
                <button onClick={() => toggleDeploy(env)}
                  className={cn("px-2.5 py-1 rounded text-xs font-medium border transition-colors min-w-[80px] text-left",
                    active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50")}>
                  {env}
                </button>
                {active && (
                  <Popover>
                    <PopoverTrigger asChild>
                      <button className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 border border-border rounded px-1.5 py-0.5">
                        <CalendarIcon size={10} />
                        {dep?.deployDate || t('taskCreate.scheduled')}
                      </button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0" align="start">
                      <Calendar mode="single" selected={dep?.deployDate ? new Date(dep.deployDate) : undefined}
                        onSelect={(date) => { if (date) { setDeployments(prev => prev.map(d => d.environment === env ? { ...d, deployDate: format(date, 'yyyy-MM-dd') } : d)); } }}
                        initialFocus className="p-3 pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            );
          })}
        </div>
      </div>
      )}
    </div>
  );
};

export default TaskFormFields;
