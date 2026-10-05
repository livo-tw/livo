import { SearchableSelect } from '@/components/ui/searchable-select';
import { useState, useEffect, useMemo } from 'react';
import { X, FileText, FileInput, ChevronRight, BookOpen, StickyNote } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { useCreateTaskForm } from '@/components/create-task/useCreateTaskForm';
import { useFocusTrap } from '@/hooks/useFocusTrap';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { DEMO_BANNER_HEIGHT } from '@/components/DemoModeBanner';

// Section components
import TaskFormFields from '@/components/create-task/TaskFormFields';
import TaskFormCustomFields from '@/components/create-task/TaskFormCustomFields';
import TaskFormSubtasks from '@/components/create-task/TaskFormSubtasks';
import TaskFormTodoList from '@/components/create-task/TaskFormTodoList';
import TaskFormChecklist from '@/components/create-task/TaskFormChecklist';
import TaskFormFileUpload from '@/components/create-task/TaskFormFileUpload';
import TaskFormDeployment from '@/components/create-task/TaskFormDeployment';
import RichTextEditor from '@/components/RichTextEditorLazy';

/** Keys of advanced fields that can be required. null = never required (always optional). */
type AdvancedFieldKey = 'background' | 'notes' | 'todos' | 'checks' | 'subtasks' | 'fileUpload' | 'deployments';
const ADVANCED_FIELD_DEFS: { key: AdvancedFieldKey; requiredKey: string | null }[] = [
  { key: 'background',  requiredKey: 'background' },
  { key: 'notes',       requiredKey: 'notes' },
  { key: 'todos',       requiredKey: 'todos' },
  { key: 'checks',      requiredKey: 'checks' },
  { key: 'subtasks',    requiredKey: null },
  { key: 'fileUpload',  requiredKey: null },
  { key: 'deployments', requiredKey: 'deployments' },
];

const CreateTaskModal = () => {
  const { t } = useTranslation();
  const [showAdvanced, setShowAdvanced] = useState(false);
  const {
    showCreateTask,
    title, setTitle,
    background, setBackground,
    requirement, setRequirement,
    notes, setNotes,
    users,
    projectId, allProjects,
    requiredFields,
    taskTemplates, applyTemplate,
    titleRef, fileInputRef,
    isValid, isSubmitting, uploading,
    showValidationErrors, setShowValidationErrors,
    todoItems, newTodoText, setNewTodoText, addTodo, removeTodo,
    checkItems, newCheckText, setNewCheckText, addCheck, removeCheck,
    subtaskItems, setSubtaskItems, newSubtaskText, setNewSubtaskText,
    pendingFiles, handleFileSelect, removePendingFile, handleDrop,
    fieldsProps, customFieldsProps, isMobile,
    hasFeature,
    handleSubmitAttempt, requestClose,
    ConfirmDialog,
  } = useCreateTaskForm();
  const focusTrapRef = useFocusTrap(showCreateTask);

  // Partition advanced fields into required (always visible) vs optional (collapsible)
  const { requiredAdvanced, optionalAdvanced } = useMemo(() => {
    const req: AdvancedFieldKey[] = [];
    const opt: AdvancedFieldKey[] = [];
    for (const def of ADVANCED_FIELD_DEFS) {
      // subtasks need feature gate check
      if (def.key === 'subtasks' && !hasFeature('subtasks')) continue;
      if (def.requiredKey && (requiredFields as Record<string, boolean>)[def.requiredKey]) {
        req.push(def.key);
      } else {
        opt.push(def.key);
      }
    }
    return { requiredAdvanced: req, optionalAdvanced: opt };
  }, [requiredFields, hasFeature]);

  const advancedFieldCount = optionalAdvanced.length;

  // Helper to render a single advanced field by key
  const renderAdvancedField = (key: AdvancedFieldKey) => {
    switch (key) {
      case 'background':
        return (
          <div key={key}>
            <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
              <BookOpen size={14} /> {t('taskCreate.backgroundLabel')}{requiredFields.background && <span className="text-destructive"> *</span>}
            </label>
            <RichTextEditor content={background} onChange={setBackground} placeholder={t('taskCreate.backgroundPlaceholder')} members={users} minimal />
          </div>
        );
      case 'notes':
        return (
          <div key={key}>
            <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
              <StickyNote size={14} /> {t('taskCreate.notesLabel')}{requiredFields.notes && <span className="text-destructive"> *</span>}
            </label>
            <RichTextEditor content={notes} onChange={setNotes} placeholder={t('taskCreate.notesPlaceholder')} members={users} minimal />
          </div>
        );
      case 'todos':
        return (
          <TaskFormTodoList key={key}
            items={todoItems} onAdd={addTodo} onRemove={removeTodo}
            newText={newTodoText} setNewText={setNewTodoText}
            required={requiredFields.todos}
          />
        );
      case 'checks':
        return (
          <TaskFormChecklist key={key}
            items={checkItems} onAdd={addCheck} onRemove={removeCheck}
            newText={newCheckText} setNewText={setNewCheckText}
            required={requiredFields.checks}
          />
        );
      case 'subtasks':
        return (
          <TaskFormSubtasks key={key}
            subtaskItems={subtaskItems} setSubtaskItems={setSubtaskItems}
            newSubtaskText={newSubtaskText} setNewSubtaskText={setNewSubtaskText}
          />
        );
      case 'fileUpload':
        return (
          <TaskFormFileUpload key={key}
            pendingFiles={pendingFiles} fileInputRef={fileInputRef}
            onFileSelect={handleFileSelect} onRemove={removePendingFile} onDrop={handleDrop}
          />
        );
      case 'deployments':
        return (
          <TaskFormDeployment key={key}
            deployments={fieldsProps.deployments} setDeployments={fieldsProps.setDeployments}
            requiredFields={requiredFields}
          />
        );
      default:
        return null;
    }
  };

  // Reset advanced section when dialog closes
  useEffect(() => {
    if (!showCreateTask) setShowAdvanced(false);
  }, [showCreateTask]);

  if (!showCreateTask) return null;

  return (
    <>
      <div
        ref={focusTrapRef}
        role="dialog"
        aria-modal="true"
        className={`fixed inset-0 z-50 bg-black/50 ${isMobile ? '' : 'flex items-center justify-center'}`}
        style={IS_DEMO_PRO ? { top: DEMO_BANNER_HEIGHT } : undefined}
        onKeyDown={e => { if (e.key === 'Escape') void requestClose(); }}
        onClick={() => { if (!isMobile) void requestClose(); }}
      >
        <div
          className={`bg-card shadow-xl border border-border flex flex-col ${isMobile ? 'w-full h-full' : 'rounded-lg max-h-[90vh]'}`}
          style={isMobile ? {} : { width: 'min(1280px, calc(100vw - 32px))' }}
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 md:px-6 pt-4 md:pt-5 pb-3 border-b border-border flex items-center justify-between flex-shrink-0">
            <div className="flex items-center gap-3">
              <h2 className="text-base font-bold text-foreground">{t('taskCreate.title')}</h2>
              {taskTemplates.length > 0 && (
                <div className="flex items-center gap-1.5">
                  <FileInput size={14} className="text-muted-foreground" />
                  <SearchableSelect
                    defaultValue=""
                    onChange={e => { if (e.target.value) applyTemplate(e.target.value); e.target.value = ''; }}
                    className="text-xs border border-border rounded px-2 py-1 bg-card text-foreground outline-none focus:ring-1 focus:ring-primary cursor-pointer"
                  >
                    <option value="">{t('taskCreate.applyTemplate')}</option>
                    {(() => {
                      const globalTemplates = taskTemplates.filter(t => !t.projectId);
                      const projectTemplates = taskTemplates.filter(t => t.projectId === projectId);
                      const otherTemplates = taskTemplates.filter(t => t.projectId && t.projectId !== projectId);
                      return (
                        <>
                          {projectTemplates.length > 0 && (
                            <optgroup label={t('taskCreate.currentProjectTemplates')}>
                              {projectTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </optgroup>
                          )}
                          {globalTemplates.length > 0 && (
                            <optgroup label={t('taskCreate.globalTemplates')}>
                              {globalTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                            </optgroup>
                          )}
                          {otherTemplates.length > 0 && (
                            <optgroup label={t('taskCreate.otherProjectTemplates')}>
                              {otherTemplates.map(t => {
                                const proj = allProjects.find(p => p.id === t.projectId);
                                return <option key={t.id} value={t.id}>{`[${proj?.name || '?'}] ${t.name}`}</option>;
                              })}
                            </optgroup>
                          )}
                        </>
                      );
                    })()}
                  </SearchableSelect>
                </div>
              )}
            </div>
            <button onClick={() => void requestClose()} aria-label={t('common.close')}
              className="flex items-center justify-center min-w-[44px] min-h-[44px] rounded hover:bg-muted text-muted-foreground hover:text-foreground transition-colors">
              <X size={18} />
            </button>
          </div>

          {/* Scrollable form area */}
          <div className="flex-1 overflow-y-auto min-h-0">
            <div className={`${isMobile ? 'flex flex-col' : 'flex gap-0 divide-x divide-border'}`}>
              {/* Left: Main content */}
              <div className={`${isMobile ? '' : 'flex-1'} px-4 md:px-6 py-4 md:py-5 space-y-4 min-w-0`}>
                {/* Title (always visible) */}
                <div>
                  <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.titleLabel')}<span className="text-destructive"> *</span></label>
                  <input
                    ref={titleRef}
                    type="text"
                    value={title}
                    onChange={e => { setTitle(e.target.value.slice(0, 500)); setShowValidationErrors(false); }}
                    placeholder={t('taskCreate.titlePlaceholder')}
                    className={`w-full border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary placeholder:text-muted-foreground/50 ${showValidationErrors && !title.trim() ? 'border-destructive ring-1 ring-destructive/50' : 'border-border'}`}
                    maxLength={500}
                  />
                </div>

                {/* Requirement (always visible - most used field by PM) */}
                <div>
                  <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
                    <FileText size={14} /> {t('taskCreate.requirementLabel')}{requiredFields.requirement && <span className="text-destructive"> *</span>}
                  </label>
                  <RichTextEditor content={requirement} onChange={setRequirement} placeholder={t('taskCreate.requirementPlaceholder')} members={users} minimal />
                </div>

                {/* Mobile: show properties panel before advanced */}
                {isMobile && (
                  <div className="border-t border-border pt-3">
                    <h3 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h3>
                    <TaskFormFields {...fieldsProps} hideDeployment />
                    <div className="mt-4"><TaskFormCustomFields {...customFieldsProps} /></div>
                  </div>
                )}

                {/* Required advanced fields — always visible */}
                {requiredAdvanced.length > 0 && (
                  <div className="space-y-4">
                    {requiredAdvanced.map(key => renderAdvancedField(key))}
                  </div>
                )}

                {/* Optional advanced fields toggle + collapsible */}
                {advancedFieldCount > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() => setShowAdvanced(v => !v)}
                      className="flex items-center gap-1.5 text-sm font-medium text-primary hover:text-primary/80 transition-colors py-1"
                    >
                      <ChevronRight size={14} className={cn("transition-transform", showAdvanced && "rotate-90")} />
                      {t('taskCreate.moreOptions', { count: advancedFieldCount })}
                    </button>

                    {showAdvanced && (
                      <div className="space-y-4 animate-in fade-in slide-in-from-top-2 duration-200">
                        {optionalAdvanced.map(key => renderAdvancedField(key))}
                      </div>
                    )}
                  </>
                )}
              </div>

              {/* Right: Metadata sidebar - Desktop only */}
              {!isMobile && (
                <div className="w-[300px] flex-shrink-0 px-5 py-5">
                  <TaskFormFields {...fieldsProps} hideDeployment />
                  <div className="mt-4"><TaskFormCustomFields {...customFieldsProps} /></div>
                </div>
              )}
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 md:px-6 py-3 border-t border-border flex justify-end gap-2 flex-shrink-0 bg-card rounded-b-lg">
            <button onClick={() => void requestClose()}
              className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground transition-colors rounded hover:bg-muted">
              {t('common.cancel')}
            </button>
            <button onClick={(uploading || isSubmitting) ? undefined : handleSubmitAttempt} disabled={uploading || isSubmitting}
              aria-busy={uploading || isSubmitting}
              className={cn("px-5 py-2 text-sm font-medium rounded transition-colors flex items-center gap-1.5",
                (uploading || isSubmitting) ? "bg-muted text-muted-foreground cursor-not-allowed" : isValid ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-primary/60 text-primary-foreground hover:bg-primary/70 cursor-pointer")}>
              {(uploading || isSubmitting) && (
                <svg className="animate-spin w-3.5 h-3.5 flex-shrink-0" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              )}
              {uploading ? t('common.uploading') : isSubmitting ? t('common.processing') : t('common.create')}
            </button>
          </div>
        </div>
      </div>
      {ConfirmDialog}
    </>
  );
};

export default CreateTaskModal;
