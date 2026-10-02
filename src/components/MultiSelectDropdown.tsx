import { useState, useRef, useEffect, ReactNode, memo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search, X, CheckSquare, Square } from 'lucide-react';

interface MultiSelectDropdownProps {
  label: string;
  options: { id: string; label: string; color?: string; avatar?: string; avatarColor?: string; icon?: ReactNode; subtitle?: string; group?: { id: string; label: string } }[];
  selected: string[];
  onToggle: (id: string) => void;
  onSelectAll?: () => void;
  onDeselectAll?: () => void;
}

const MultiSelectDropdown = memo(({ label, options, selected, onToggle }: MultiSelectDropdownProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, []);

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus();
    }
  }, [open]);

  const selectedLabels = options.filter(o => selected.includes(o.id)).map(o => o.label);

  const filteredOptions = search.trim()
    ? options.filter(o => o.label.toLowerCase().includes(search.trim().toLowerCase()) || (o.subtitle && o.subtitle.toLowerCase().includes(search.trim().toLowerCase())))
    : options;

  const allSelected = options.length > 0 && options.every(o => selected.includes(o.id));
  const someSelected = selected.length > 0;

  const handleToggleAll = () => {
    if (allSelected) {
      // Deselect all
      options.forEach(o => {
        if (selected.includes(o.id)) onToggle(o.id);
      });
    } else {
      // Select all
      options.forEach(o => {
        if (!selected.includes(o.id)) onToggle(o.id);
      });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`border rounded-lg px-2.5 py-2 text-sm bg-card text-foreground outline-none hover:ring-1 hover:ring-primary flex items-center gap-1 min-w-[80px] min-h-[36px] transition-all ${
          selected.length > 0 ? 'border-primary/40 bg-primary/5 font-medium' : 'border-border'
        }`}
      >
        <span className="truncate max-w-[150px]">
          {selectedLabels.length === 0 ? `${t('common.all')} ${label}` : selectedLabels.join(', ')}
        </span>
        <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''} text-muted-foreground`} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-lg shadow-xl z-50 min-w-[220px] w-max max-w-[calc(100vw-16px)] max-h-80 overflow-hidden py-1">
          {/* Search input */}
          <div className="px-2 pb-1.5 pt-1 border-b border-border/50">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-muted/50">
              <Search size={14} className="text-muted-foreground flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder={t('common.search') + '...'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground/50 w-full"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
                  <X size={13} />
                </button>
              )}
            </div>
          </div>

          {/* Select All / Deselect All */}
          {!search.trim() && options.length > 1 && (
            <button
              onClick={handleToggleAll}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left border-b border-border/50"
            >
              {allSelected ? (
                <CheckSquare size={15} className="text-primary flex-shrink-0" />
              ) : (
                <Square size={15} className="text-muted-foreground flex-shrink-0" />
              )}
              <span className={`font-medium ${allSelected ? 'text-primary' : 'text-muted-foreground'}`}>
                {allSelected ? t('button.deselectAll') : t('button.selectAll')}
              </span>
            </button>
          )}

          <div className="max-h-56 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground text-center">{t('common.noResults')}</div>
            ) : (
              filteredOptions.map((opt, index) => (
                <Fragment key={opt.id}>
                {opt.group && (index === 0 || filteredOptions[index - 1].group?.id !== opt.group.id) && <div className="px-3 pt-2 pb-1 text-xs font-semibold text-muted-foreground" role="presentation">{opt.group.label}</div>}
                <button
                  key={opt.id}
                  onClick={() => onToggle(opt.id)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-accent transition-colors text-left"
                >
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${selected.includes(opt.id) ? 'bg-primary border-primary' : 'border-border'}`}>
                    {selected.includes(opt.id) && <span className="text-[9px] text-primary-foreground">✓</span>}
                  </div>
                  {opt.avatar && (
                    <div
                      className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white flex-shrink-0"
                      style={{ backgroundColor: opt.avatarColor || '#6B778C' }}
                    >
                      {opt.avatar}
                    </div>
                  )}
                  {opt.icon && <span className="flex-shrink-0">{opt.icon}</span>}
                  {opt.color && !opt.avatar && !opt.icon && <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: opt.color }} />}
                  <span className="text-foreground flex-1 truncate">{opt.label}</span>
                  {opt.subtitle && <span className="text-xs text-muted-foreground/60 flex-shrink-0 ml-auto">{opt.subtitle}</span>}
                </button>
                </Fragment>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
});

MultiSelectDropdown.displayName = 'MultiSelectDropdown';

export default MultiSelectDropdown;
