import { memo } from 'react';
import { ListTree, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface TaskFormSubtasksProps {
  subtaskItems: string[];
  setSubtaskItems: (items: string[] | ((prev: string[]) => string[])) => void;
  newSubtaskText: string;
  setNewSubtaskText: (v: string) => void;
}

const TaskFormSubtasks = memo(({
  subtaskItems, setSubtaskItems, newSubtaskText, setNewSubtaskText,
}: TaskFormSubtasksProps) => {
  const { t } = useTranslation();
  const addSubtask = () => {
    const txt = newSubtaskText.trim();
    if (txt) {
      setSubtaskItems(prev => [...prev, txt]);
      setNewSubtaskText('');
    }
  };

  return (
    <div className="border-t border-border pt-3">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-1.5">
          <ListTree size={16} /> {t('taskCreate.subtasks')}
          {subtaskItems.length > 0 && (
            <span className="text-xs font-medium text-muted-foreground">({subtaskItems.length})</span>
          )}
        </h3>
      </div>
      {subtaskItems.length > 0 && (
        <div className="space-y-1 mb-2">
          {subtaskItems.map((text, i) => (
            <div key={i} className="flex items-center gap-2 group">
              <span className="w-2 h-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
              <span className="flex-1 text-sm text-foreground">{text}</span>
              <button
                onClick={() => setSubtaskItems(prev => prev.filter((_, idx) => idx !== i))}
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
          value={newSubtaskText}
          onChange={e => setNewSubtaskText(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addSubtask();
            }
          }}
          placeholder={t('taskCreate.subtaskPlaceholder')}
          className="flex-1 text-sm border border-border rounded px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-primary bg-card text-foreground placeholder:text-muted-foreground/50"
        />
        <button
          onClick={addSubtask}
          disabled={!newSubtaskText.trim()}
          className={`p-1.5 rounded transition-colors ${newSubtaskText.trim() ? 'text-primary hover:bg-primary/10' : 'text-muted-foreground/30 cursor-not-allowed'}`}
        >
          <Plus size={14} />
        </button>
      </div>
    </div>
  );
});

export default TaskFormSubtasks;
