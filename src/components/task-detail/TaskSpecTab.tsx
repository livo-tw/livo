import { safeLinkHref } from '@/lib/safeLink';
import { useState, memo } from 'react';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { BookOpen, FileText, StickyNote, ListChecks, CheckCircle2, Paperclip, Plus, Check, Pencil, X, ExternalLink, Trash2, Lock } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';
import { fixHtml } from './utils';
import TaskSidebarFields from './TaskSidebarFields';
import { useUnsavedDraft } from '@/lib/unsavedDrafts';

// ─────────────────────────────────────────────────────────────────────────────
// RichFieldEditor — inline editor component
// ─────────────────────────────────────────────────────────────────────────────

type RichFieldEditorProps = {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  fieldKey: string;
  users: TaskDetailState['users'];
  onMention: (userId: string) => void;
  onConfirm: (onChange: (v: string) => void, draft: string) => void;
  onCancel: (onChange: (v: string) => void) => void;
};

const RichFieldEditor = memo(({ value, onChange, placeholder, users, onMention, onConfirm, onCancel }: RichFieldEditorProps) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(value);
  const empty = (html: string) => !html || html === '<p></p>';
  useUnsavedDraft('task', draft !== value && !(empty(draft) && empty(value)), t('taskDetail.spec.discardDraft'));
  return (
    <div>
      <RichTextEditor content={draft} onChange={setDraft} placeholder={placeholder} members={users} onMention={onMention} />
      <div className="flex gap-1.5 mt-1.5">
        <button onClick={() => onConfirm(onChange, draft)} className="px-2.5 py-1 text-xs rounded bg-primary text-primary-foreground hover:bg-primary/90">{t('taskDetail.spec.confirmEdit')}</button>
        <button onClick={() => onCancel(onChange)} className="px-2.5 py-1 text-xs rounded border border-border text-muted-foreground hover:bg-accent">{t('taskDetail.spec.cancelEdit')}</button>
      </div>
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// RichField — display + edit toggle
// ─────────────────────────────────────────────────────────────────────────────

type RichFieldProps = {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon?: React.ReactNode;
  editingField: string | null;
  getFieldLocker: TaskDetailState['getFieldLocker'];
  users: TaskDetailState['users'];
  onMention: TaskDetailState['handleSpecMention'];
  onStartEdit: (fieldKey: string, value: string) => void;
  onConfirm: (onChange: (v: string) => void, draft: string) => void;
  onCancel: (onChange: (v: string) => void) => void;
};

const RichField = memo(({ label, value, onChange, placeholder, icon, editingField, getFieldLocker, users, onMention, onStartEdit, onConfirm, onCancel }: RichFieldProps) => {
  const { t } = useTranslation();
  const fieldKey = label;
  const isEditing = editingField === fieldKey;
  const locker = getFieldLocker(fieldKey);
  return (
    <div>
      <div className="flex items-center gap-2 mb-1.5">
        <h4 className="text-sm font-semibold text-foreground flex items-center gap-1">{icon} {label}</h4>
        {locker && (
          <span className="text-xs text-orange-600 bg-orange-50 px-1.5 py-0.5 rounded animate-pulse flex items-center gap-1">
            <Lock size={12} /> {t('taskDetail.spec.beingEdited', { name: locker.name })}
          </span>
        )}
      </div>
      {isEditing ? (
        <RichFieldEditor
          value={value} onChange={onChange} placeholder={placeholder} fieldKey={fieldKey}
          users={users} onMention={onMention} onConfirm={onConfirm} onCancel={onCancel}
        />
      ) : (
        <div
          onClick={() => onStartEdit(fieldKey, value)}
          className={`w-full text-sm leading-relaxed border rounded px-3 py-2.5 min-h-[52px] rich-content bg-muted ${locker ? 'cursor-not-allowed opacity-60' : 'cursor-text'} ${value && value !== '<p></p>' ? 'text-foreground' : 'text-muted-foreground'}`}
          style={{ borderColor: locker ? 'hsl(var(--destructive))' : 'hsl(var(--border))' }}
          dangerouslySetInnerHTML={{ __html: value && value !== '<p></p>' ? fixHtml(value) : placeholder }}
        />
      )}
    </div>
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// TaskSpecTab
// ─────────────────────────────────────────────────────────────────────────────

type Props = { detail: TaskDetailState };

const TaskSpecTab = ({ detail }: Props) => {
  const { t } = useTranslation();
  const {
    task, users,
    specBackground, setSpecBackground,
    specRequirement, setSpecRequirement,
    specNotes, setSpecNotes,
    editingField, getFieldLocker,
    handleSpecMention, richFieldStartEdit, richFieldConfirm, richFieldCancel,
    todos, newTodoText, setNewTodoText,
    editingTodoId, editingTodoText, setEditingTodoText,
    toggleTodo, removeTodo, addTodo, startEditTodo, saveEditTodo, cancelEditTodo,
    checks, newCheckText, setNewCheckText,
    editingCheckId, editingCheckText, setEditingCheckText,
    checkedCount, allChecked,
    toggleCheck, removeCheck, addCheck, startEditCheck, saveEditCheck, cancelEditCheck,
    attachments, fileUploading, fileInputRef,
    storageUsed, STORAGE_LIMIT, MAX_FILE_SIZE,
    handleFileUpload, deleteAttachment, getPublicUrl,
    isMobile,
  } = detail;

  if (!task) return null;

  const richFieldProps = {
    editingField,
    getFieldLocker,
    users,
    onMention: handleSpecMention,
    onStartEdit: richFieldStartEdit,
    onConfirm: richFieldConfirm,
    onCancel: richFieldCancel,
  };

  return (
    <div className="space-y-4 md:space-y-5">
      <RichField label={t('taskDetail.spec.background')} icon={<BookOpen size={16} />} value={specBackground} onChange={setSpecBackground} placeholder={t('taskDetail.spec.backgroundPlaceholder')} {...richFieldProps} />
      <RichField label={t('taskDetail.spec.requirement')} icon={<FileText size={16} />} value={specRequirement} onChange={setSpecRequirement} placeholder={t('taskDetail.spec.requirementPlaceholder')} {...richFieldProps} />
      <RichField label={t('taskDetail.spec.notes')} icon={<StickyNote size={16} />} value={specNotes} onChange={setSpecNotes} placeholder={t('taskDetail.spec.notesPlaceholder')} {...richFieldProps} />

      {/* To Do List */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-1"><ListChecks size={16} /> {t('taskDetail.spec.todoList')}</h4>
          {todos.length > 0 && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${todos.every(t => t.isDone) ? 'bg-primary/20 text-primary' : 'bg-muted text-muted-foreground'}`}>
              {todos.filter(t => t.isDone).length}/{todos.length}
            </span>
          )}
        </div>
        {todos.length > 0 && (
          <div className="w-full bg-muted rounded-full h-1.5 mb-2">
            <div className="bg-primary h-1.5 rounded-full transition-all" style={{ width: `${todos.length > 0 ? (todos.filter(t => t.isDone).length / todos.length) * 100 : 0}%` }} />
          </div>
        )}
        <div className="space-y-1.5">
          {todos.map(todo => {
            const lockKey = `todo_${todo.id}`;
            const locker = getFieldLocker(lockKey);
            const isEditingThis = editingTodoId === todo.id;
            return (
              <div key={todo.id} className="flex items-center gap-2 group">
                <button onClick={() => toggleTodo(todo.id)} className="flex-shrink-0">
                  <div className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${todo.isDone ? 'bg-primary' : 'border-2 border-border'}`}>
                    {todo.isDone && <Check size={10} className="text-white" />}
                  </div>
                </button>
                {isEditingThis ? (
                  <div className="flex-1 flex items-center gap-1">
                    <input value={editingTodoText} onChange={e => setEditingTodoText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEditTodo(); if (e.key === 'Escape') cancelEditTodo(); }}
                      autoFocus className="flex-1 text-sm border border-primary rounded px-2 py-1 outline-none bg-card text-foreground" />
                    <button onClick={saveEditTodo} className="p-1 text-status-done hover:bg-status-done/10 rounded"><Check size={13} /></button>
                    <button onClick={cancelEditTodo} className="p-1 text-muted-foreground hover:bg-accent rounded"><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <span className={`flex-1 text-sm ${todo.isDone ? 'line-through text-muted-foreground' : 'text-foreground'} ${locker ? 'opacity-60' : ''}`}>
                      {todo.text}
                    </span>
                    {locker && <span className="text-[11px] text-orange-600 bg-orange-50 px-1 py-0.5 rounded animate-pulse flex-shrink-0 flex items-center gap-0.5"><Lock size={10} /> {locker.name}</span>}
                    <button onClick={() => startEditTodo(todo)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all flex-shrink-0"><Pencil size={11} /></button>
                    <button onClick={() => removeTodo(todo.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"><X size={12} /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <input value={newTodoText} onChange={e => setNewTodoText(e.target.value)} onKeyDown={e => e.key === 'Enter' && addTodo()}
            placeholder={t('taskDetail.spec.todoPlaceholder')} className="flex-1 text-sm border border-border rounded px-2.5 py-1.5 outline-none focus:border-primary bg-card text-foreground placeholder:text-muted-foreground/50" />
          <button onClick={addTodo} disabled={!newTodoText.trim()} className={`p-1.5 rounded transition-colors ${newTodoText.trim() ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/30 cursor-not-allowed'}`}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      {/* Checklist / 驗收標準 */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-1"><CheckCircle2 size={16} /> {t('taskDetail.spec.checklist')}</h4>
          {checks.length > 0 && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full ${allChecked ? 'bg-status-done/20 text-status-done' : 'bg-muted text-muted-foreground'}`}>
              {checkedCount}/{checks.length}
            </span>
          )}
        </div>
        {checks.length > 0 && (
          <div className="w-full bg-muted rounded-full h-1.5 mb-2">
            <div className="bg-status-done h-1.5 rounded-full transition-all" style={{ width: `${(checkedCount / checks.length) * 100}%` }} />
          </div>
        )}
        <div className="space-y-1.5">
          {checks.map(check => {
            const lockKey = `check_${check.id}`;
            const locker = getFieldLocker(lockKey);
            const isEditingThis = editingCheckId === check.id;
            return (
              <div key={check.id} className="flex items-center gap-2 group">
                <button onClick={() => toggleCheck(check.id)} className="flex-shrink-0">
                  <div className={`w-4 h-4 rounded flex items-center justify-center transition-colors ${check.isDone ? 'bg-emerald-500' : 'border-2 border-border'}`}>
                    {check.isDone && <Check size={10} className="text-white" />}
                  </div>
                </button>
                {isEditingThis ? (
                  <div className="flex-1 flex items-center gap-1">
                    <input value={editingCheckText} onChange={e => setEditingCheckText(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') saveEditCheck(); if (e.key === 'Escape') cancelEditCheck(); }}
                      autoFocus className="flex-1 text-sm border border-primary rounded px-2 py-1 outline-none bg-card text-foreground" />
                    <button onClick={saveEditCheck} className="p-1 text-status-done hover:bg-status-done/10 rounded"><Check size={13} /></button>
                    <button onClick={cancelEditCheck} className="p-1 text-muted-foreground hover:bg-accent rounded"><X size={13} /></button>
                  </div>
                ) : (
                  <>
                    <span className={`flex-1 text-sm ${check.isDone ? 'line-through text-muted-foreground' : 'text-foreground'} ${locker ? 'opacity-60' : ''}`}>
                      {check.text}
                    </span>
                    {locker && <span className="text-[11px] text-orange-600 bg-orange-50 px-1 py-0.5 rounded animate-pulse flex-shrink-0 flex items-center gap-0.5"><Lock size={10} /> {locker.name}</span>}
                    <button onClick={() => startEditCheck(check)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-primary transition-all flex-shrink-0"><Pencil size={11} /></button>
                    <button onClick={() => removeCheck(check.id)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all flex-shrink-0"><X size={12} /></button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <input value={newCheckText} onChange={e => setNewCheckText(e.target.value)} onKeyDown={e => e.key === 'Enter' && addCheck()}
            placeholder={t('taskDetail.spec.checklistPlaceholder')} className="flex-1 text-sm border border-border rounded px-2.5 py-1.5 outline-none focus:border-primary bg-card text-foreground placeholder:text-muted-foreground/50" />
          <button onClick={addCheck} disabled={!newCheckText.trim()} className={`p-1.5 rounded transition-colors ${newCheckText.trim() ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/30 cursor-not-allowed'}`}>
            <Plus size={14} />
          </button>
        </div>
      </div>

      {safeLinkHref(task.gitlabUrl) && (
        <div className="rounded px-3 py-2 flex items-center gap-2 bg-yellow-50 dark:bg-yellow-900/20">
          <ExternalLink size={12} className="text-primary flex-shrink-0" />
          <a href={safeLinkHref(task.gitlabUrl)!} target="_blank" rel="noopener noreferrer" className="text-sm text-primary truncate hover:underline">{task.gitlabUrl}</a>
        </div>
      )}

      {/* Attachments */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-1"><Paperclip size={16} /> {t('taskDetail.spec.attachments')}</h4>
          <button onClick={() => fileInputRef.current?.click()} className="text-xs text-primary hover:text-primary/80 flex items-center gap-1">
            <Plus size={12} /> {t('button.upload')}
          </button>
        </div>
        <input ref={fileInputRef} type="file" multiple accept="*/*" onChange={e => e.target.files && handleFileUpload(e.target.files)} className="hidden" />
        <div
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); e.dataTransfer.files.length && handleFileUpload(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          className="border-2 border-dashed rounded-lg p-3 md:p-4 text-center cursor-pointer hover:border-primary hover:bg-primary/5 transition-colors border-border bg-muted/30"
        >
          <Paperclip size={18} className="mx-auto mb-1 text-muted-foreground" />
          <p className="text-xs text-muted-foreground" dangerouslySetInnerHTML={{ __html: t('taskDetail.spec.dragDropMessage') }} />
          <p className="text-[10px] text-muted-foreground mt-1">{t('taskDetail.spec.fileSizeNote', { size: MAX_FILE_SIZE / 1024 / 1024 })}</p>
        </div>
        {storageUsed !== null && (
          <div className="mt-1.5 flex items-center gap-2">
            {STORAGE_LIMIT !== null && (
              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${Math.min((storageUsed / STORAGE_LIMIT) * 100, 100)}%` }} />
              </div>
            )}
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {(storageUsed / 1024 / 1024).toFixed(1)} MB{STORAGE_LIMIT !== null && ` / ${STORAGE_LIMIT >= 1024 * 1024 * 1024 ? `${(STORAGE_LIMIT / 1024 / 1024 / 1024).toFixed(0)} GB` : `${(STORAGE_LIMIT / 1024 / 1024).toFixed(0)} MB`}`}
            </span>
          </div>
        )}
        {fileUploading && <p className="text-xs text-primary text-center mt-2">{t('common.uploading')}</p>}
        {attachments.length > 0 && (
          <div className="mt-2 space-y-2">
            {(() => {
              const images = attachments.filter(a => a.file_type?.startsWith('image/'));
              const files = attachments.filter(a => !a.file_type?.startsWith('image/'));
              return (
                <>
                  {images.length > 0 && (
                    <div className={`grid gap-2 ${isMobile ? 'grid-cols-2' : 'grid-cols-3'}`}>
                      {images.map(att => (
                        <div key={att.id} className="relative group rounded overflow-hidden border border-border">
                          <a href={getPublicUrl(att.storage_path)} target="_blank" rel="noopener noreferrer">
                            <img src={getPublicUrl(att.storage_path)} alt={att.file_name} className="w-full h-24 object-cover" loading="lazy" />
                          </a>
                          <button onClick={() => deleteAttachment(att)} className="absolute top-1 right-1 p-1 rounded bg-black/50 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive">
                            <Trash2 size={12} />
                          </button>
                          <p className="text-[10px] text-muted-foreground truncate px-1 py-0.5">{att.file_name}</p>
                        </div>
                      ))}
                    </div>
                  )}
                  {files.length > 0 && (
                    <div className="space-y-1.5">
                      {files.map(att => (
                        <div key={att.id} className="flex items-center gap-2 p-2 rounded border border-border group">
                          <FileText size={16} className="text-muted-foreground flex-shrink-0" />
                          <div className="flex-1 min-w-0">
                            <a href={getPublicUrl(att.storage_path)} target="_blank" rel="noopener noreferrer" className="text-sm text-foreground hover:text-primary truncate block">{att.file_name}</a>
                            <p className="text-[10px] text-muted-foreground">{att.file_size ? `${(att.file_size / 1024).toFixed(1)} KB` : ''}</p>
                          </div>
                          <button onClick={() => deleteAttachment(att)} className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all p-1">
                            <Trash2 size={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {/* Mobile: Sidebar fields */}
      {isMobile && (
        <div className="border-t border-border pt-4">
          <h4 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-1"><FileText size={16} /> {t('task.properties')}</h4>
          <TaskSidebarFields detail={detail} />
        </div>
      )}
    </div>
  );
};

export default TaskSpecTab;