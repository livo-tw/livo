import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Settings2 } from 'lucide-react';
import type { User, Status, Project, CustomField } from '@/types';
import { type CardFieldVisibility, KANBAN_CARD_FIELD_OPTIONS } from '@/lib/fieldRegistry';
import DepartmentFilter from '@/components/DepartmentFilter';
import MultiSelectDropdown from '@/components/MultiSelectDropdown';
import { priorityConfig } from '@/components/ui/badges';
import { sortUsersByDept, type Department } from '@/lib/department';
import { useIsMobile } from '@/hooks/use-mobile';
import { useTranslation } from 'react-i18next';

interface BoardFiltersProps {
  users: User[];
  statuses: Status[];
  allProjects: Project[];
  selectedProjectId: string | null;
  filterDept: Department[];
  setFilterDept: (v: Department[]) => void;
  filterAssignees: string[];
  setFilterAssignees: React.Dispatch<React.SetStateAction<string[]>>;
  filterStatuses: string[];
  setFilterStatuses: React.Dispatch<React.SetStateAction<string[]>>;
  filterPriorities: string[];
  setFilterPriorities: React.Dispatch<React.SetStateAction<string[]>>;
  filterReviewers: string[];
  setFilterReviewers: React.Dispatch<React.SetStateAction<string[]>>;
  filterProjects: string[];
  setFilterProjects: React.Dispatch<React.SetStateAction<string[]>>;
  hasFilters: boolean;
  clearFilters: () => void;
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
  users, statuses, allProjects, selectedProjectId,
  filterDept, setFilterDept,
  filterAssignees, setFilterAssignees,
  filterStatuses, setFilterStatuses,
  filterPriorities, setFilterPriorities,
  filterReviewers, setFilterReviewers,
  filterProjects, setFilterProjects,
  hasFilters, clearFilters,
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

  const toggleArr = useCallback((setter: React.Dispatch<React.SetStateAction<string[]>>) => (id: string) =>
    setter(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]), []);

  const priorityOptions = useMemo(() => Object.entries(priorityConfig).map(([id, p]) => ({
    id, label: p.label, icon: p.icon as React.ReactElement,
  })), []);

  const projectCustomFields = customFields.filter(f => visibleProjectIds.includes(f.projectId));

  return (
    <div className="flex items-center gap-1.5 md:gap-2 px-3 md:px-5 pb-3 md:pb-4 flex-wrap">
      <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mr-1 hidden md:inline">{t('filter.label')}</span>
      <DepartmentFilter value={filterDept} onChange={setFilterDept} />
      <MultiSelectDropdown label={isMobile ? t('filter.assigneeMobile') : t('filter.assignee')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterAssignees} onToggle={toggleArr(setFilterAssignees)} />
      <MultiSelectDropdown label={t('filter.status')} options={statuses.map(s => ({ id: s.id, label: s.name, color: s.color }))} selected={filterStatuses} onToggle={toggleArr(setFilterStatuses)} />
      <MultiSelectDropdown label={isMobile ? t('filter.priorityMobile') : t('filter.priority')} options={priorityOptions} selected={filterPriorities} onToggle={toggleArr(setFilterPriorities)} />
      <MultiSelectDropdown label={isMobile ? t('filter.reviewerMobile') : t('filter.reviewer')} options={sortUsersByDept(users.filter(u => u.isActive)).map(u => ({ id: u.id, label: u.name, avatar: u.avatar, avatarColor: u.color, subtitle: u.jobTitle }))} selected={filterReviewers} onToggle={toggleArr(setFilterReviewers)} />
      {!selectedProjectId && (
        <MultiSelectDropdown label={t('filter.project')} options={allProjects.filter(p => !p.isArchived).map(p => ({ id: p.id, label: p.name, color: p.color }))} selected={filterProjects} onToggle={toggleArr(setFilterProjects)} />
      )}
      {hasFilters && (
        <button onClick={clearFilters} className="text-[13px] text-primary hover:text-primary/80 font-medium">{t('button.clearFilters')}</button>
      )}
      <div className="relative ml-auto" ref={cardSettingsRef}>
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
    </div>
  );
};

export default BoardFilters;
