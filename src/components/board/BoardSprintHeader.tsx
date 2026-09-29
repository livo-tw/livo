import type { RefObject } from 'react';
import { Zap, Users, Pencil, Check, X } from 'lucide-react';

export interface BoardSprintHeaderProps {
  selectedProjectId: string | null;
  allProjects: Array<{ id: string; name: string; [key: string]: any }>;
  totalFiltered: number;
  sprintActive: boolean;
  currentSprint: { id: string; name: string } | null;
  isMobile: boolean;
  standupMode: boolean;
  canEditSprint: boolean;
  editingSprintName: boolean;
  editSprintValue: string;
  sprintInputRef: RefObject<HTMLInputElement>;
  onEditSprintValue: (v: string) => void;
  onStartEditSprintName: () => void;
  onSaveSprintName: () => void;
  onCancelEditSprintName: () => void;
  onSprintAction: () => void;
  onStartNewSprint: () => void;
  onStandup: () => void;
  t: (key: string, opts?: any) => string;
}

const BoardSprintHeader = ({
  selectedProjectId,
  allProjects,
  totalFiltered,
  sprintActive,
  currentSprint,
  isMobile,
  standupMode,
  canEditSprint,
  editingSprintName,
  editSprintValue,
  sprintInputRef,
  onEditSprintValue,
  onStartEditSprintName,
  onSaveSprintName,
  onCancelEditSprintName,
  onSprintAction,
  onStartNewSprint,
  onStandup,
  t,
}: BoardSprintHeaderProps) => {
  return (
    <div className="flex items-center justify-between px-3 md:px-5 pt-3 md:pt-4 pb-1 flex-wrap gap-2">
      <div className="flex items-center gap-2 flex-wrap">
        <h1 className="text-base md:text-lg font-bold text-foreground">
          {selectedProjectId ? allProjects.find(p => p.id === selectedProjectId)?.name : t('board.titleAll')}
        </h1>
        <span className="text-[13px] text-muted-foreground">({totalFiltered})</span>
        {sprintActive && currentSprint && (
          <span className="text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary font-medium">
            ⚡ {currentSprint.name}
          </span>
        )}
      </div>
      {/* Sprint controls */}
      <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
        {sprintActive && currentSprint ? (
          <>
            {!isMobile && (
              <div className="flex items-center gap-1">
                {editingSprintName ? (
                  <div className="flex items-center gap-1">
                    <input
                      ref={sprintInputRef}
                      type="text"
                      value={editSprintValue}
                      onChange={e => onEditSprintValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') onSaveSprintName();
                        if (e.key === 'Escape') onCancelEditSprintName();
                      }}
                      className="bg-muted text-foreground text-xs rounded px-2 py-1 border border-border outline-none focus:ring-1 focus:ring-primary w-40"
                    />
                    <button onClick={onSaveSprintName} className="text-muted-foreground hover:text-foreground"><Check size={14} /></button>
                    <button onClick={onCancelEditSprintName} className="text-muted-foreground hover:text-foreground"><X size={14} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1">
                    <span className="text-xs text-muted-foreground">{currentSprint.name}</span>
                    {canEditSprint && (
                      <button onClick={onStartEditSprintName} className="text-muted-foreground/50 hover:text-foreground"><Pencil size={12} /></button>
                    )}
                  </div>
                )}
              </div>
            )}
            <button
              onClick={onSprintAction}
              className="flex items-center gap-1 px-2.5 md:px-3 py-1.5 rounded text-[13px] font-medium transition-colors border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
            >
              <Zap size={14} />
              {isMobile ? t('button.complete') : t('button.completeSprint')}
            </button>
          </>
        ) : (
          <button
            onClick={onStartNewSprint}
            className="flex items-center gap-1 px-2.5 md:px-3 py-1.5 rounded text-[13px] font-medium transition-colors border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20"
          >
            <Zap size={14} />
            {isMobile ? t('button.startSprint') : t('button.startSprint')}
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

export default BoardSprintHeader;
