import { groupProjectsByLine } from '@/lib/projectGroups';
import { useState } from 'react';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useAuthContext } from '@/context/AuthContext';
import { useLicense } from '@/context/LicenseContext';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { TaskTemplate, Priority } from '@/types';
import { Pencil, Trash2, Plus, X, FileInput, ClipboardList, Eye } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import RequiredFieldsSettings from '@/components/RequiredFieldsSettings';
import UpgradePrompt from '@/components/UpgradePrompt';
import TaskTemplateForm from '@/components/TaskTemplateForm';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';

const TaskTemplateManager = () => {
  const { t } = useTranslation();
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const { taskTemplates, createTaskTemplate, updateTaskTemplate, deleteTaskTemplate, tags } = useTaskContext();
  const { allProjects, productLines } = useProjectContext();
  const { users } = useMemberContext();
  const { currentMemberId, permissions } = useAuthContext();
  const { hasFeature } = useLicense();

  const [editing, setEditing] = useState<TaskTemplate | null>(null);
  const [creating, setCreating] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewTemplate, setPreviewTemplate] = useState<TaskTemplate | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formProjectId, setFormProjectId] = useState<string>('');
  const [formPriority, setFormPriority] = useState<Priority | ''>('');
  const [formTagIds, setFormTagIds] = useState<string[]>([]);
  const [formBackground, setFormBackground] = useState('');
  const [formRequirement, setFormRequirement] = useState('');
  const [formNotes, setFormNotes] = useState('');
  const [formCheckItems, setFormCheckItems] = useState<string[]>([]);
  const [formTodoItems, setFormTodoItems] = useState<string[]>([]);
  const [newCheckText, setNewCheckText] = useState('');
  const [newTodoText, setNewTodoText] = useState('');

  const resetForm = () => {
    setFormName('');
    setFormDescription('');
    setFormProjectId('');
    setFormPriority('');
    setFormTagIds([]);
    setFormBackground('');
    setFormRequirement('');
    setFormNotes('');
    setFormCheckItems([]);
    setFormTodoItems([]);
    setNewCheckText('');
    setNewTodoText('');
  };

  const openCreate = () => {
    resetForm();
    setEditing(null);
    setCreating(true);
  };

  const openEdit = (tmpl: TaskTemplate) => {
    setFormName(tmpl.name);
    setFormDescription(tmpl.description);
    setFormProjectId(tmpl.projectId || '');
    setFormPriority(tmpl.defaultPriority || '');
    setFormTagIds(tmpl.defaultTagIds);
    setFormBackground(tmpl.defaultSpecBackground);
    setFormRequirement(tmpl.defaultSpecRequirement);
    setFormNotes(tmpl.defaultSpecNotes);
    setFormCheckItems(tmpl.defaultCheckItems || []);
    setFormTodoItems(tmpl.defaultTodoItems || []);
    setEditing(tmpl);
    setCreating(true);
  };

  const handleSave = async () => {
    if (!formName.trim()) { toast.error(t('template.nameRequired')); return; }
    if (isSubmitting) return;
    setIsSubmitting(true);
    try {
      if (editing) {
        await updateTaskTemplate(editing.id, {
          name: formName.trim(),
          description: formDescription,
          projectId: formProjectId || null,
          defaultPriority: (formPriority as Priority) || null,
          defaultTagIds: formTagIds,
          defaultSpecBackground: formBackground,
          defaultSpecRequirement: formRequirement,
          defaultSpecNotes: formNotes,
          defaultCheckItems: formCheckItems,
          defaultTodoItems: formTodoItems,
        });
        toast.success(t('taskTemplate.templateUpdated'));
      } else {
        await createTaskTemplate({
          name: formName.trim(),
          description: formDescription,
          projectId: formProjectId || null,
          defaultPriority: (formPriority as Priority) || null,
          defaultTagIds: formTagIds,
          defaultSpecBackground: formBackground,
          defaultSpecRequirement: formRequirement,
          defaultSpecNotes: formNotes,
          defaultCheckItems: formCheckItems,
          defaultTodoItems: formTodoItems,
          createdBy: currentMemberId,
        });
        toast.success(t('taskTemplate.templateCreated'));
      }
      setCreating(false);
      setEditing(null);
      resetForm();
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (tmpl: TaskTemplate) => {
    if (!(await confirm({ description: t('taskTemplate.deleteConfirm', { name: tmpl.name }), title: t('taskTemplate.confirmAction'), destructive: true }))) return;
    await deleteTaskTemplate(tmpl.id);
  };

  const groupedProjects = groupProjectsByLine(productLines, allProjects, { includeUnclassified: false });

  const handleCancel = () => {
    setCreating(false);
    setEditing(null);
    resetForm();
  };

  if (creating) {
    return (
      <>
      <TaskTemplateForm
        editing={editing}
        formName={formName} setFormName={setFormName}
        formDescription={formDescription} setFormDescription={setFormDescription}
        formProjectId={formProjectId} setFormProjectId={setFormProjectId}
        formPriority={formPriority} setFormPriority={setFormPriority}
        formTagIds={formTagIds} setFormTagIds={setFormTagIds}
        formBackground={formBackground} setFormBackground={setFormBackground}
        formRequirement={formRequirement} setFormRequirement={setFormRequirement}
        formNotes={formNotes} setFormNotes={setFormNotes}
        formCheckItems={formCheckItems} setFormCheckItems={setFormCheckItems}
        formTodoItems={formTodoItems} setFormTodoItems={setFormTodoItems}
        newCheckText={newCheckText} setNewCheckText={setNewCheckText}
        newTodoText={newTodoText} setNewTodoText={setNewTodoText}
        isSubmitting={isSubmitting}
        groupedProjects={groupedProjects}
        tags={tags} users={users}
        onSave={handleSave} onCancel={handleCancel}
      />
      {ConfirmDialog}
    </>
    );
  }

  return (
    <>
    <div className="h-full overflow-y-auto"><div className="max-w-4xl mx-auto p-4 space-y-6">
      <div className="flex items-center justify-between mb-6 pb-4 border-b border-border">
        <div className="flex items-center gap-2">
          <FileInput size={20} className="text-primary" />
          <h1 className="text-2xl font-bold text-foreground">{t('taskTemplate.pageTitle')}</h1>
        </div>
      </div>

      {/* Section 1: Task Templates */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <FileInput size={18} className="text-primary" />
            {t('taskTemplate.templateSection')}
          </h2>
          {permissions.canEditProject && (
            <button onClick={openCreate}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 transition-colors">
              <Plus size={14} /> {t('taskTemplate.addTemplate')}
            </button>
          )}
        </div>

        {taskTemplates.length === 0 ? (
          <div className="text-center py-12">
            <FileInput size={40} className="mx-auto mb-3 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground mb-1">{t('taskTemplate.noTemplates')}</p>
            <p className="text-xs text-muted-foreground/60">{t('taskTemplate.noTemplatesHint')}</p>
          </div>
        ) : (
          <div className="space-y-2">
            {taskTemplates.map(tmpl => {
              const proj = tmpl.projectId ? allProjects.find(p => p.id === tmpl.projectId) : null;
              const creator = users.find(u => u.id === tmpl.createdBy);
              return (
                <div key={tmpl.id} className="border border-border rounded-lg p-3 hover:bg-accent/30 transition-colors">
                  <div className="flex items-start justify-between">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-medium text-sm text-foreground">{tmpl.name}</span>
                        {proj ? (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary font-medium">{proj.name}</span>
                        ) : (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium">{t('taskTemplate.global')}</span>
                        )}
                        {tmpl.defaultPriority && (
                          <span className="text-[10px] text-muted-foreground">
                            {tmpl.defaultPriority && t(`priority.${tmpl.defaultPriority}`)}
                          </span>
                        )}
                      </div>
                      {tmpl.description && <p className="text-xs text-muted-foreground mb-1">{tmpl.description}</p>}
                      <div className="flex items-center gap-2 flex-wrap mb-2">
                        {tmpl.defaultTagIds.map(tagId => {
                          const tag = tags.find(t => t.id === tagId);
                          if (!tag) return null;
                          return (
                            <span key={tag.id} className="px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                              style={{ backgroundColor: tag.color }}>
                              {tag.name}
                            </span>
                          );
                        })}
                      </div>
                      {(tmpl.defaultCheckItems?.length || 0) > 0 && (
                        <div className="text-[10px] text-muted-foreground mb-1">
                          <span className="font-semibold">{t('taskTemplate.checklistCount', { count: tmpl.defaultCheckItems?.length || 0 })}</span> {tmpl.defaultCheckItems?.slice(0, 2).join('、') || ''}{(tmpl.defaultCheckItems?.length || 0) > 2 ? '...' : ''}
                        </div>
                      )}
                      {(tmpl.defaultTodoItems?.length || 0) > 0 && (
                        <div className="text-[10px] text-muted-foreground mb-1">
                          <span className="font-semibold">{t('taskTemplate.todoCount', { count: tmpl.defaultTodoItems?.length || 0 })}</span> {tmpl.defaultTodoItems?.slice(0, 2).join('、') || ''}{(tmpl.defaultTodoItems?.length || 0) > 2 ? '...' : ''}
                        </div>
                      )}
                      {creator && <span className="text-[10px] text-muted-foreground/60">{t('taskTemplate.creatorLabel')}{creator.name}</span>}
                    </div>
                    <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                      <button onClick={() => setPreviewTemplate(tmpl)} title={t('taskTemplate.viewTemplate')}
                        className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                        <Eye size={14} />
                      </button>
                      {permissions.canEditProject && (
                        <>
                          <button onClick={() => openEdit(tmpl)}
                            className="p-1.5 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors">
                            <Pencil size={14} />
                          </button>
                          <button onClick={() => handleDelete(tmpl)}
                            className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors">
                            <Trash2 size={14} />
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Section 2: Required Fields Settings */}
      {permissions.canManageStatuses && (
        <div className="space-y-4 pt-4 border-t border-border">
          <h2 className="text-base font-semibold text-foreground flex items-center gap-2">
            <ClipboardList size={18} className="text-primary" />
            {t('taskTemplate.requiredFieldsTitle')}
          </h2>
          {hasFeature('required-fields') ? (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ClipboardList size={18} /> {t('taskTemplate.requiredFieldsCardTitle')}
                </CardTitle>
                <CardDescription>{t('taskTemplate.requiredFieldsCardDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <RequiredFieldsSettings />
              </CardContent>
            </Card>
          ) : (
            <UpgradePrompt feature="required-fields" inline />
          )}
        </div>
      )}

      {/* Preview Modal */}
      {previewTemplate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
          onClick={() => setPreviewTemplate(null)}>
          <div className="bg-card rounded-lg shadow-lg max-w-lg w-full max-h-[90vh] overflow-y-auto border border-border"
            onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h2 className="text-lg font-bold text-foreground">{previewTemplate.name}</h2>
              <button onClick={() => setPreviewTemplate(null)} className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
                <X size={18} />
              </button>
            </div>
            <div className="px-6 py-4 space-y-4">
              {previewTemplate.description && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">{t('taskTemplate.descriptionLabel')}</p>
                  <p className="text-sm text-foreground">{previewTemplate.description}</p>
                </div>
              )}
              {previewTemplate.defaultPriority && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">{t('taskTemplate.priorityLabel')}</p>
                  <p className="text-sm text-foreground">{previewTemplate.defaultPriority && t(`priority.${previewTemplate.defaultPriority}`)}</p>
                </div>
              )}
              {previewTemplate.defaultTagIds.length > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">{t('taskTemplate.tagsLabel')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {previewTemplate.defaultTagIds.map(tagId => {
                      const tag = tags.find(t => t.id === tagId);
                      if (!tag) return null;
                      return (
                        <span key={tag.id} className="px-2 py-0.5 rounded text-xs font-medium text-white"
                          style={{ backgroundColor: tag.color }}>
                          {tag.name}
                        </span>
                      );
                    })}
                  </div>
                </div>
              )}
              {previewTemplate.defaultSpecBackground && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">{t('taskTemplate.backgroundLabel')}</p>
                  <div className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-3">{previewTemplate.defaultSpecBackground}</div>
                </div>
              )}
              {previewTemplate.defaultSpecRequirement && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">{t('taskTemplate.requirementLabel')}</p>
                  <div className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-3">{previewTemplate.defaultSpecRequirement}</div>
                </div>
              )}
              {previewTemplate.defaultSpecNotes && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-1">{t('taskTemplate.notesLabel')}</p>
                  <div className="text-sm text-foreground whitespace-pre-wrap break-words line-clamp-3">{previewTemplate.defaultSpecNotes}</div>
                </div>
              )}
              {(previewTemplate.defaultCheckItems?.length || 0) > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">{t('taskTemplate.defaultChecklist')}</p>
                  <ul className="space-y-1">
                    {previewTemplate.defaultCheckItems?.map((item, idx) => (
                      <li key={idx} className="text-sm text-foreground flex items-start gap-2">
                        <span className="text-muted-foreground">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {(previewTemplate.defaultTodoItems?.length || 0) > 0 && (
                <div>
                  <p className="text-xs font-semibold text-muted-foreground mb-2">{t('taskTemplate.defaultTodoList')}</p>
                  <ul className="space-y-1">
                    {previewTemplate.defaultTodoItems?.map((item, idx) => (
                      <li key={idx} className="text-sm text-foreground flex items-start gap-2">
                        <span className="text-muted-foreground">•</span>
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {users.find(u => u.id === previewTemplate.createdBy) && (
                <div className="text-xs text-muted-foreground pt-2 border-t border-border">
                  {t('taskTemplate.creatorLabel')}{users.find(u => u.id === previewTemplate.createdBy)?.name}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div></div>
    {ConfirmDialog}
    </>
  );
};

export default TaskTemplateManager;
