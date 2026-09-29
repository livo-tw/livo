import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, FileText, StickyNote } from 'lucide-react';
import RichTextEditor from '@/components/RichTextEditorLazy';
import type { User } from '@/types';

export interface TaskFormBasicProps {
  titleRef: React.RefObject<HTMLInputElement>;
  title: string;
  setTitle: (v: string) => void;
  showValidationErrors: boolean;
  setShowValidationErrors: (v: boolean) => void;
  background: string;
  setBackground: (v: string) => void;
  requirement: string;
  setRequirement: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  users: User[];
  requiredFields: Record<string, boolean>;
  hideTitle?: boolean;
  hideRequirement?: boolean;
}

const TaskFormBasic = memo(({
  titleRef, title, setTitle, showValidationErrors, setShowValidationErrors,
  background, setBackground, requirement, setRequirement, notes, setNotes,
  users, requiredFields, hideTitle, hideRequirement,
}: TaskFormBasicProps) => {
  const { t } = useTranslation();
  return (
  <>
    {/* Title */}
    {!hideTitle && (
      <div>
        <label className="text-sm font-medium text-muted-foreground mb-1 block">{t('taskCreate.titleLabel')}</label>
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
    )}

    {/* Spec section */}
    <div>
      <h3 className="text-sm font-semibold text-foreground mb-2">{t(hideRequirement ? 'taskCreate.detailSection' : 'taskCreate.requirementSection')}</h3>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
            <BookOpen size={14} /> {t('taskCreate.backgroundLabel')}{requiredFields.background && <span className="text-destructive"> *</span>}
          </label>
          <RichTextEditor content={background} onChange={setBackground} placeholder={t('taskCreate.backgroundPlaceholder')} members={users} minimal />
        </div>
        {!hideRequirement && (
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
            <FileText size={14} /> {t('taskCreate.requirementLabel')}{requiredFields.requirement && <span className="text-destructive"> *</span>}
          </label>
          <RichTextEditor content={requirement} onChange={setRequirement} placeholder={t('taskCreate.requirementPlaceholder')} members={users} minimal />
        </div>
        )}
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-0.5 block flex items-center gap-1">
            <StickyNote size={14} /> {t('taskCreate.notesLabel')}{requiredFields.notes && <span className="text-destructive"> *</span>}
          </label>
          <RichTextEditor content={notes} onChange={setNotes} placeholder={t('taskCreate.notesPlaceholder')} members={users} minimal />
        </div>
      </div>
    </div>
  </>
  );
});

export default TaskFormBasic;
