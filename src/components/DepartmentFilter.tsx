import { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, Search, X, CheckSquare, Square } from 'lucide-react';
import { DEPARTMENTS, deptColors, type Department } from '@/lib/department';

const DepartmentFilter = memo(({
  value,
  onChange,
}: {
  value: Department[];
  onChange: (v: Department[]) => void;
}) => {
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

  const filteredDepts = search.trim()
    ? DEPARTMENTS.filter(d => d.toLowerCase().includes(search.trim().toLowerCase()))
    : DEPARTMENTS;

  const allSelected = DEPARTMENTS.length > 0 && DEPARTMENTS.every(d => value.includes(d));

  const handleToggle = (dept: Department) => {
    onChange(
      value.includes(dept) ? value.filter(d => d !== dept) : [...value, dept]
    );
  };

  const handleToggleAll = () => {
    if (allSelected) {
      onChange([]);
    } else {
      onChange([...DEPARTMENTS]);
    }
  };

  const selectedLabels = value.length === 0
    ? t('filter.allDepartments')
    : value.length <= 2
      ? value.join(', ')
      : t('filter.departmentsCount', { count: value.length });

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`border rounded-lg px-2.5 py-2 text-sm bg-card text-foreground outline-none hover:ring-1 hover:ring-primary flex items-center gap-1 min-w-[80px] min-h-[36px] transition-all ${
          value.length > 0 ? 'border-primary/40 bg-primary/5 font-medium' : 'border-border'
        }`}
      >
        <span className="truncate max-w-[150px]">{selectedLabels}</span>
        <ChevronDown size={14} className={`flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''} text-muted-foreground`} />
      </button>
      {open && (
        <div className="absolute top-full mt-1 left-0 bg-card border border-border rounded-lg shadow-xl z-50 min-w-[200px] w-max max-w-[calc(100vw-16px)] max-h-80 overflow-hidden py-1">
          {/* Search */}
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

          {/* Select All */}
          {!search.trim() && (
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
            {filteredDepts.length === 0 ? (
              <div className="px-3 py-3 text-sm text-muted-foreground text-center">{t('common.noResults')}</div>
            ) : (
              filteredDepts.map(d => (
                <button
                  key={d}
                  onClick={() => handleToggle(d)}
                  className="w-full flex items-center gap-2 px-3 py-2.5 text-sm hover:bg-accent transition-colors text-left"
                >
                  <div className={`w-4 h-4 rounded border-2 flex items-center justify-center flex-shrink-0 ${value.includes(d) ? 'bg-primary border-primary' : 'border-border'}`}>
                    {value.includes(d) && <span className="text-[9px] text-primary-foreground">✓</span>}
                  </div>
                  <span className="text-foreground">{d}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
});

DepartmentFilter.displayName = 'DepartmentFilter';

export default DepartmentFilter;