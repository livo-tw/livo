import { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Settings2, GripVertical, Check, RotateCcw } from 'lucide-react';
import type { ColumnConfig, ColumnDef } from '@/hooks/useColumnConfig';

interface Props {
  config: ColumnConfig;
  fixedKeys: string[];
}

const ColumnConfigDropdown = memo(({ config, fixedKeys }: Props) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  // Only show optional columns (non-fixed) for toggling
  const optionalCols = config.allColumns.filter(c => !fixedKeys.includes(c.key));
  // Currently selected optional columns in order
  const orderedSelected = config.visibleKeys;

  const handleDragStart = (idx: number) => setDragIndex(idx);
  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIndex(idx);
  };
  const handleDragEnd = () => {
    if (dragIndex !== null && dragOverIndex !== null && dragIndex !== dragOverIndex) {
      config.reorder(dragIndex, dragOverIndex);
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 px-2.5 py-1.5 text-sm font-medium rounded-md border border-border bg-card text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <Settings2 size={14} />
        {t('settings.columns')}
        {orderedSelected.length > 0 && (
          <span className="bg-primary/10 text-primary rounded-full px-1.5 text-[10px] font-semibold">{orderedSelected.length}</span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 max-w-[calc(100vw-16px)] bg-card border border-border rounded-lg shadow-lg py-1 max-h-[400px] overflow-y-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-border">
            <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">{t('settings.selectVisibleColumns')}</span>
            <button
              onClick={() => config.resetToDefault()}
              className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              <RotateCcw size={10} />
              {t('settings.resetToDefault')}
            </button>
          </div>

          {/* Fixed columns (always shown, grayed out) */}
          {config.allColumns.filter(c => fixedKeys.includes(c.key)).map(col => (
            <div key={col.key} className="flex items-center gap-2 px-3 py-1.5 text-xs text-muted-foreground opacity-50">
              <Check size={12} />
              <span>{col.label}</span>
              <span className="ml-auto text-[10px]">{t('common.pinned')}</span>
            </div>
          ))}

          <div className="border-t border-border my-0.5" />

          {/* Selected columns (draggable for reordering) */}
          {orderedSelected.length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                {t('settings.selectedColumns')}
              </div>
              {orderedSelected.map((key, idx) => {
                const col = optionalCols.find(c => c.key === key);
                if (!col) return null;
                return (
                  <div
                    key={col.key}
                    draggable
                    onDragStart={() => handleDragStart(idx)}
                    onDragOver={e => handleDragOver(e, idx)}
                    onDragEnd={handleDragEnd}
                    className={`flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent transition-colors ${
                      dragOverIndex === idx && dragIndex !== idx ? 'bg-primary/10' : ''
                    } ${dragIndex === idx ? 'opacity-40' : ''}`}
                    onClick={() => config.toggle(col.key)}
                  >
                    <GripVertical size={12} className="text-muted-foreground cursor-grab flex-shrink-0" />
                    <Check size={12} className="text-primary flex-shrink-0" />
                    <span className="text-foreground">{col.label}</span>
                  </div>
                );
              })}
              <div className="border-t border-border my-0.5" />
            </>
          )}

          {/* Unselected columns */}
          {optionalCols.filter(c => !orderedSelected.includes(c.key)).length > 0 && (
            <>
              <div className="px-3 py-1 text-[10px] font-bold text-muted-foreground uppercase tracking-wider">
                {t('settings.availableColumns')}
              </div>
              {optionalCols.filter(c => !orderedSelected.includes(c.key)).map(col => (
                <div
                  key={col.key}
                  className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-accent transition-colors"
                  onClick={() => config.toggle(col.key)}
                >
                  <div className="w-3 h-3 rounded border border-border flex-shrink-0" />
                  <span className="text-muted-foreground">{col.label}</span>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
});

ColumnConfigDropdown.displayName = 'ColumnConfigDropdown';

export default ColumnConfigDropdown;
