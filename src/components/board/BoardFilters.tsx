import { useState, useRef, useEffect } from 'react';
import { Settings2 } from 'lucide-react';
import type { User, Status, Project, CustomField } from '@/types';
import { type CardFieldVisibility, KANBAN_CARD_FIELD_OPTIONS } from '@/lib/fieldRegistry';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';
import type { BoardFilterState } from '@/hooks/useBoardFilters';
import type { BoardSort } from '@/lib/boardSort';
import BoardFilterChips from './BoardFilterChips';
import BoardSortMenu from './BoardSortMenu';

interface BoardFiltersProps {
  users: User[];
  statuses: Status[];
  allProjects: Project[];
  selectedProjectId: string | null;
  filters: BoardFilterState;
  sort: BoardSort;
  onSortChange: (sort: BoardSort) => void;
  // Card field settings
  cardFields: CardFieldVisibility;
  toggleCardField: (field: keyof CardFieldVisibility) => void;
  subtaskDisplayMode: 'independent' | 'nested';
  setSubtaskDisplayMode: (mode: 'independent' | 'nested') => void;
  hasSubtasksFeature: boolean;
  customFields: CustomField[];
  customCardFields: Record<string, boolean>;
  toggleCustomCardField: (fieldId: string) => void;
  visibleProjectIds: string[];
}

const BoardFilters = ({
  users, statuses, allProjects, selectedProjectId, filters, sort, onSortChange,
  cardFields, toggleCardField,
  subtaskDisplayMode, setSubtaskDisplayMode,
  hasSubtasksFeature,
  customFields, customCardFields, toggleCustomCardField,
  visibleProjectIds,
}: BoardFiltersProps) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [showCardSettings, setShowCardSettings] = useState(false);
  const cardSettingsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showCardSettings) return;
    const handler = (e: MouseEvent) => {
      if (cardSettingsRef.current && !cardSettingsRef.current.contains(e.target as Node)) {
        setShowCardSettings(false);
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [showCardSettings]);

  const projectCustomFields = customFields.filter(f => visibleProjectIds.includes(f.projectId));

  return (
    <div className="px-3 md:px-5 pb-3 md:pb-4">
    <BoardFilterChips users={users} statusOptions={statuses.map(status => ({ id: status.id, label: status.name, color: status.color }))}
      allProjects={allProjects} showProjects={!selectedProjectId} filters={filters} trailing={<>
      <BoardSortMenu value={sort} onChange={onSortChange} />
      <div className="relative" ref={cardSettingsRef}>
        <button
          onClick={() => setShowCardSettings(!showCardSettings)}
          className={`flex items-center gap-1 px-2 py-1.5 text-[13px] font-medium rounded-md border transition-colors ${
            showCardSettings ? 'bg-primary/10 text-primary border-primary/30' : 'border-border text-muted-foreground hover:text-foreground hover:bg-accent'
          }`}
          title={t('board.cardSettings')}
        >
          <Settings2 size={14} />
          {!isMobile && <span>{t('board.cardFields')}</span>}
        </button>
        {showCardSettings && (
          <div className="absolute right-0 top-full mt-1 w-52 max-w-[calc(100vw-16px)] bg-card rounded-lg border border-border shadow-lg z-50 py-1.5">
            <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground border-b border-border mb-1">{t('board.cardFieldsDropdown')}</div>
            {KANBAN_CARD_FIELD_OPTIONS.map(opt => (
              <label
                key={opt.key}
                className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={cardFields[opt.key]}
                  onChange={() => toggleCardField(opt.key)}
                  className="rounded border-border"
                />
                <span className="text-foreground">{opt.label}</span>
              </label>
            ))}
            {hasSubtasksFeature && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground border-t border-border mt-1 mb-1">{t('board.subtaskDisplay')}</div>
                {(['independent', 'nested'] as const).map(mode => (
                  <label key={mode} className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer transition-colors">
                    <input
                      type="radio"
                      name="subtask-mode"
                      checked={subtaskDisplayMode === mode}
                      onChange={() => setSubtaskDisplayMode(mode)}
                      className="rounded-full border-border"
                    />
                    <span className="text-foreground">{mode === 'independent' ? t('board.subtaskIndependent') : t('board.subtaskNested')}</span>
                  </label>
                ))}
              </>
            )}
            {projectCustomFields.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground border-t border-border mt-1 mb-1">{t('board.customFields')}</div>
                {projectCustomFields.map(cf => (
                  <label
                    key={cf.id}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={!!customCardFields[cf.id]}
                      onChange={() => toggleCustomCardField(cf.id)}
                      className="rounded border-border"
                    />
                    <span className="text-foreground">{cf.fieldName}</span>
                  </label>
                ))}
              </>
            )}
            <div className="border-t border-border mt-1 pt-1 px-3 py-1">
              <span className="text-[11px] text-muted-foreground">{t('board.cardFieldsRequired')}</span>
            </div>
          </div>
        )}
      </div>
    </>} />
    </div>
  );
};

export default BoardFilters;
