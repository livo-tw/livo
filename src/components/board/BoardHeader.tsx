import { useState, useRef } from 'react';
import { ChevronDown, ChevronRight, Zap, Users, Pencil, Check, X, Trophy } from 'lucide-react';
import type { Project, Status } from '@/types';
import type { Sprint } from '@/context/SprintContext';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';

interface BoardHeaderProps {
  selectedProjectId: string | null;
  allProjects: Project[];
  totalFiltered: number;
  sprintActive: boolean;
  currentSprint: Sprint | null;
  canEditSprint: boolean;
  standupMode: boolean;
  onSprintAction: () => void;
  onStandup: () => void;
  onRenameSprint: (sprintId: string, newName: string) => Promise<void>;
}

const BoardHeader = ({
  selectedProjectId, allProjects, totalFiltered,
  sprintActive, currentSprint, canEditSprint,
  standupMode, onSprintAction, onStandup, onRenameSprint,
}: BoardHeaderProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [editingSprintName, setEditingSprintName] = useState(false);
  const [editSprintValue, setEditSprintValue] = useState('');
  const sprintInputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = () => {
    if (currentSprint && canEditSprint) {
      setEditSprintValue(currentSprint.name);
      setEditingSprintName(true);
      setTimeout(() => sprintInputRef.current?.focus(), 50);
    }
  };

  const handleSave = async () => {
    if (!currentSprint || !editSprintValue.trim()) return;
    if (editSprintValue.trim() !== currentSprint.name) {
      await onRenameSprint(currentSprint.id, editSprintValue.trim());
    }
    setEditingSprintName(false);
  };

  return (
    <div className="flex items-center justify-between px-3 md:px-5 pt-3 md:pt-4 pb-1 flex-wrap gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-base md:text-lg font-bold text-foreground">
          {selectedProjectId ? allProjects.find(p => p.id === selectedProjectId)?.name : t('board.titleAll')}
        </h1>
        <span className="text-[13px] text-muted-foreground">({totalFiltered})</span>
        {sprintActive && currentSprint && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium flex items-center gap-1">
            <Zap size={12} />
            {currentSprint.name}
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
        {sprintActive && currentSprint && !isMobile && (
          <div className="flex items-center gap-1">
            {editingSprintName ? (
              <div className="flex items-center gap-1">
                <input
                  ref={sprintInputRef}
                  type="text"
                  value={editSprintValue}
                  onChange={e => setEditSprintValue(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') handleSave();
                    if (e.key === 'Escape') setEditingSprintName(false);
                  }}
                  className="bg-muted text-foreground text-xs rounded px-2 py-1 border border-border outline-none focus:ring-1 focus:ring-primary w-40"
                />
                <button onClick={handleSave} className="text-muted-foreground hover:text-foreground"><Check size={14} /></button>
                <button onClick={() => setEditingSprintName(false)} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
              </div>
            ) : (
              <div className="flex items-center gap-1">
                <span className="text-xs text-muted-foreground">{currentSprint.name}</span>
                {canEditSprint && (
                  <button onClick={handleStartEdit} className="text-muted-foreground/50 hover:text-foreground"><Pencil size={12} /></button>
                )}
              </div>
            )}
          </div>
        )}
        {canEditSprint && (
          <button
            onClick={onSprintAction}
            className="flex items-center gap-1 px-2.5 md:px-3 py-1.5 rounded text-[13px] font-medium transition-colors border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
          >
            <Zap size={14} />
            {sprintActive && currentSprint
              ? (isMobile ? t('button.complete') : t('button.completeSprint'))
              : (isMobile ? t('button.startSprint') : t('button.startSprint'))}
          </button>
        )}
        {!isMobile && (
          <button
            onClick={onStandup}
            className={`flex items-center gap-1 px-3 py-1.5 rounded text-[13px] font-semibold transition-colors border ${
              standupMode
                ? 'bg-destructive text-destructive-foreground border-destructive hover:bg-destructive/90'
                : 'text-foreground border-border hover:bg-accent'
            }`}
          >
            <Users size={14} />
            {standupMode ? t('button.exit') : t('sidebar.standup')}
          </button>
        )}
      </div>
    </div>
  );
};

export default BoardHeader;
