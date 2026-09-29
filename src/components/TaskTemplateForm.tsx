import { X } from 'lucide-react';
import RichTextEditor from '@/components/RichTextEditorLazy';
import { TaskTemplate, Priority, Tag, User, ProductLine, Project } from '@/types';
import { useTranslation } from 'react-i18next';

export const priorities: { value: Priority; label: string }[] = [
  { value: 'highest', label: 'Highest' },
  { value: 'high', label: 'High' },
  { value: 'medium', label: 'Medium' },
  { value: 'low', label: 'Low' },
  { value: 'lowest', label: 'Lowest' },
];

export interface GroupedProject {
  line: ProductLine;
  projects: Project[];
}

interface TaskTemplateFormProps {
  editing: TaskTemplate | null;
  formName: string;
  setFormName: (v: string) => void;
  formDescription: string;
  setFormDescription: (v: string) => void;
  formProjectId: string;
  setFormProjectId: (v: string) => void;
  formPriority: Priority | '';
  setFormPriority: (v: Priority | '') => void;
  formTagIds: string[];
  setFormTagIds: React.Dispatch<React.SetStateAction<string[]>>;
  formBackground: string;
  setFormBackground: (v: string) => void;
  formRequirement: string;
  setFormRequirement: (v: string) => void;
  formNotes: string;
  setFormNotes: (v: string) => void;
  formCheckItems: string[];
  setFormCheckItems: React.Dispatch<React.SetStateAction<string[]>>;
  formTodoItems: string[];
  setFormTodoItems: React.Dispatch<React.SetStateAction<string[]>>;
  newCheckText: string;
  setNewCheckText: (v: string) => void;
  newTodoText: string;
  setNewTodoText: (v: string) => void;
  isSubmitting: boolean;
  groupedProjects: GroupedProject[];
  tags: Tag[];
  users: User[];
  onSave: () => void;
  onCancel: () => void;
}

const TaskTemplateForm = ({
  editing,
  formName, setFormName,
  formDescription, setFormDescription,
  formProjectId, setFormProjectId,
  formPriority, setFormPriority,
  formTagIds, setFormTagIds,
  formBackground, setFormBackground,
  formRequirement, setFormRequirement,
  formNotes, setFormNotes,
  formCheckItems, setFormCheckItems,
  formTodoItems, setFormTodoItems,
  newCheckText, setNewCheckText,
  newTodoText, setNewTodoText,
  isSubmitting,
  groupedProjects,
  tags, users,
  onSave, onCancel,
}: TaskTemplateFormProps) => {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-y-auto"><div className="max-w-3xl mx-auto p-4">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold text-foreground">{editing ? t('taskTemplate.editTemplate') : t('taskTemplate.addTemplate')}</h2>
        <button onClick={onCancel}
          className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors">
          <X size={18} />
        </button>
      </div>
      <div className="space-y-4">
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.templateNameLabel')} <span className="text-destructive">*</span></label>
          <input type="text" value={formName} onChange={e => setFormName(e.target.value)}
            placeholder={t('taskTemplate.templateNamePlaceholder')}
            className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.descriptionLabel')}</label>
          <input type="text" value={formDescription} onChange={e => setFormDescription(e.target.value)}
            placeholder={t('taskTemplate.descriptionPlaceholder')}
            className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" />
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.applicableProjectLabel')}</label>
          <select value={formProjectId} onChange={e => setFormProjectId(e.target.value)}
            className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
            <option value="">{t('taskTemplate.globalProject')}</option>
            {groupedProjects.map(g => (
              <optgroup key={g.line.id} label={`${g.line.icon} ${g.line.name}`}>
                {g.projects.map(p => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.defaultPriorityLabel')}</label>
          <select value={formPriority} onChange={e => setFormPriority(e.target.value as Priority | '')}
            className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
            <option value="">{t('taskTemplate.noPriority')}</option>
            {priorities.map(p => (<option key={p.value} value={p.value}>{p.label}</option>))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.defaultTagsLabel')}</label>
          <div className="flex flex-wrap gap-1.5 mb-1.5">
            {formTagIds.map(tagId => {
              const tag = tags.find(t => t.id === tagId);
              if (!tag) return null;
              return (
                <span key={tag.id} className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium text-white"
                  style={{ backgroundColor: tag.color }}>
                  {tag.name}
                  <button type="button" onClick={() => setFormTagIds(prev => prev.filter(id => id !== tagId))} className="hover:opacity-80">
                    <X size={12} />
                  </button>
                </span>
              );
            })}
          </div>
          <select value="" onChange={e => { if (e.target.value) setFormTagIds(prev => [...prev, e.target.value]); }}
            className="w-full border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary">
            <option value="">{t('taskTemplate.addTagPlaceholder')}</option>
            {tags.filter(t => !formTagIds.includes(t.id)).map(tag => (
              <option key={tag.id} value={tag.id}>{tag.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.defaultBackgroundLabel')}</label>
          <RichTextEditor content={formBackground} onChange={setFormBackground} placeholder={t('taskTemplate.backgroundPlaceholder')} members={users} minimal />
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.defaultRequirementLabel')}</label>
          <RichTextEditor content={formRequirement} onChange={setFormRequirement} placeholder={t('taskTemplate.requirementPlaceholder')} members={users} minimal />
        </div>
        <div>
          <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskTemplate.defaultNotesLabel')}</label>
          <RichTextEditor content={formNotes} onChange={setFormNotes} placeholder={t('taskTemplate.notesPlaceholder')} members={users} minimal />
        </div>
        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('taskTemplate.defaultChecklist')}</h3>
          <div className="space-y-2 mb-2">
            {formCheckItems.map((item, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <div className="flex-1 px-2.5 py-1.5 text-sm bg-background rounded border border-border text-foreground">{item}</div>
                <button type="button" onClick={() => setFormCheckItems(prev => prev.filter((_, i) => i !== idx))}
                  className="px-2 py-1 text-xs rounded text-destructive hover:bg-destructive/10">{t('common.delete')}</button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input type="text" value={newCheckText} onChange={e => setNewCheckText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newCheckText.trim()) { setFormCheckItems(prev => [...prev, newCheckText.trim()]); setNewCheckText(''); } }}
              placeholder={t('taskTemplate.addCheckPlaceholder')}
              className="flex-1 border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" />
            <button type="button" onClick={() => { if (newCheckText.trim()) { setFormCheckItems(prev => [...prev, newCheckText.trim()]); setNewCheckText(''); } }}
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90">{t('common.add')}</button>
          </div>
        </div>
        <div className="border-t border-border pt-4">
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('taskTemplate.defaultTodoList')}</h3>
          <div className="space-y-2 mb-2">
            {formTodoItems.map((item, idx) => (
              <div key={idx} className="flex items-center gap-1.5">
                <div className="flex-1 px-2.5 py-1.5 text-sm bg-background rounded border border-border text-foreground">{item}</div>
                <button type="button" onClick={() => setFormTodoItems(prev => prev.filter((_, i) => i !== idx))}
                  className="px-2 py-1 text-xs rounded text-destructive hover:bg-destructive/10">{t('common.delete')}</button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input type="text" value={newTodoText} onChange={e => setNewTodoText(e.target.value)} onKeyDown={e => { if (e.key === 'Enter' && newTodoText.trim()) { setFormTodoItems(prev => [...prev, newTodoText.trim()]); setNewTodoText(''); } }}
              placeholder={t('taskTemplate.addTodoPlaceholder')}
              className="flex-1 border border-border rounded px-2.5 py-1.5 text-sm bg-card text-foreground outline-none focus:ring-1 focus:ring-primary" />
            <button type="button" onClick={() => { if (newTodoText.trim()) { setFormTodoItems(prev => [...prev, newTodoText.trim()]); setNewTodoText(''); } }}
              className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:bg-primary/90">{t('common.add')}</button>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t border-border">
          <button onClick={onCancel}
            className="px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded hover:bg-muted transition-colors">
            {t('common.cancel')}
          </button>
          <button onClick={onSave} disabled={!formName.trim() || isSubmitting}
            className="px-5 py-2 text-sm font-medium rounded bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors">
            {isSubmitting ? t('common.processing') : editing ? t('taskTemplate.update') : t('common.create')}
          </button>
        </div>
      </div>
    </div></div>
  );
};

export default TaskTemplateForm;
