import { Layers, Maximize2, PanelRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskDisplayMode } from '@/context/UIContext';

/** Shared task and QA presentation preferences. Changing view never saves a record. */
export function RecordViewModeButtons({ value, onChange, disabled = false }: {
  value: TaskDisplayMode; onChange: (mode: TaskDisplayMode) => void; disabled?: boolean;
}) {
  const { t } = useTranslation();
  return <>{([{ mode: 'modal', Icon: Layers }, { mode: 'side', Icon: PanelRight }, { mode: 'page', Icon: Maximize2 }] as const).map(({ mode, Icon }) =>
    <button type="button" key={mode} disabled={disabled} onClick={() => onChange(mode)} title={t(`task.displayMode.${mode}`)}
      aria-label={t(`task.displayMode.${mode}`)} aria-pressed={value === mode}
      className={`rounded p-1.5 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-50 ${value === mode ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground'}`}>
      <Icon size={15} aria-hidden="true" />
    </button>)}</>;
}
