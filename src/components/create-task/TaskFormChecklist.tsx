import { Plus, X, CheckCircle2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface TaskFormChecklistProps {
  items: string[];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  newText: string;
  setNewText: (v: string) => void;
  required?: boolean;
}

const TaskFormChecklist = ({ items, onAdd, onRemove, newText, setNewText, required }: TaskFormChecklistProps) => {
  const { t } = useTranslation();
  return (
    <div className="border-t border-border pt-3">
      <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1">
        <CheckCircle2 size={16} /> {t('taskCreate.checklist')}{required && <span className="text-destructive"> *</span>}
      </h3>
      {items.length > 0 && (
        <div className="space-y-1 mb-2">
          {items.map((text, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <div className="w-3.5 h-3.5 rounded border-2 border-border flex-shrink-0" />
              <span className="flex-1 text-sm text-foreground">{text}</span>
              <button
                onClick={() => onRemove(i)}
                className="text-muted-foreground hover:text-destructive transition-all md:opacity-0 md:group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1.5">
        <input
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAdd()}
          placeholder={t('taskCreate.checklistPlaceholder')}
          className="flex-1 text-sm border border-border rounded px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-primary bg-card text-foreground placeholder:text-muted-foreground/50"
        />
        <button
          onClick={onAdd}
          disabled={!newText.trim()}
          className={`p-1.5 rounded transition-colors ${newText.trim() ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/30 cursor-not-allowed'}`}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
};

export default TaskFormChecklist;
