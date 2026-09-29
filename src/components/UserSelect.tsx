import { useState, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { ChevronDown, Search, X } from 'lucide-react';
import { sortUsersByDept } from '@/lib/department';

interface UserSelectProps {
  value: string;
  onChange: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  className?: string;
  size?: 'sm' | 'md';
}

const UserSelect = memo(({ value, onChange, allowEmpty = false, emptyLabel = '—', className = '', size = 'sm' }: UserSelectProps) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { users } = useMemberContext();

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

  const selected = users.find(u => u.id === value);
  const avatarSize = size === 'sm' ? 'w-5 h-5 text-[7px]' : 'w-6 h-6 text-[8px]';
  const textSize = size === 'sm' ? 'text-xs' : 'text-xs';

  const sortedUsers = sortUsersByDept(users);
  const filteredUsers = search.trim()
    ? sortedUsers.filter(u => u.name.toLowerCase().includes(search.trim().toLowerCase()) || u.jobTitle.toLowerCase().includes(search.trim().toLowerCase()))
    : sortedUsers;

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-1.5 border border-border rounded px-2 py-1.5 bg-card text-foreground outline-none focus:ring-1 focus:ring-primary hover:bg-accent/30 transition-colors"
      >
        {selected ? (
          <>
            <div
              className={`${avatarSize} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0`}
              style={{ backgroundColor: selected.color }}
            >
              {selected.avatar}
            </div>
            <span className={`${textSize} truncate`}>{selected.name}</span>
          </>
        ) : (
          <span className={`${textSize} text-muted-foreground/50`}>{emptyLabel}</span>
        )}
        <ChevronDown size={12} className="ml-auto text-muted-foreground flex-shrink-0" />
      </button>

      {open && (
        <div className="absolute z-50 mt-1 w-full min-w-[180px] max-w-[calc(100vw-16px)] bg-card border border-border rounded-md shadow-lg max-h-[260px] overflow-hidden py-1">
          {/* Search */}
          <div className="px-2 pb-1.5 pt-1 border-b border-border/50">
            <div className="flex items-center gap-1.5 px-2 py-1.5 rounded bg-muted/50">
              <Search size={13} className="text-muted-foreground flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder={t('common.search') + '...'}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="bg-transparent outline-none text-xs text-foreground placeholder:text-muted-foreground/50 w-full"
              />
              {search && (
                <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
                  <X size={12} />
                </button>
              )}
            </div>
          </div>
          <div className="max-h-[200px] overflow-y-auto">
            {allowEmpty && (
              <button
                type="button"
                onClick={() => { onChange(''); setOpen(false); setSearch(''); }}
                className={`w-full flex items-center gap-1.5 px-2 py-1.5 ${textSize} text-muted-foreground hover:bg-accent transition-colors ${!value ? 'bg-accent/50' : ''}`}
              >
                {emptyLabel}
              </button>
            )}
            {filteredUsers.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground text-center">{t('common.noResults')}</div>
            ) : (
              filteredUsers.map(u => (
                <button
                  key={u.id}
                  type="button"
                  onClick={() => { onChange(u.id); setOpen(false); setSearch(''); }}
                  className={`w-full flex items-center gap-2 px-2 py-1.5 hover:bg-accent transition-colors ${value === u.id ? 'bg-accent/50' : ''}`}
                >
                  <div
                    className={`${avatarSize} rounded-full flex items-center justify-center font-bold text-white flex-shrink-0`}
                    style={{ backgroundColor: u.color }}
                  >
                    {u.avatar}
                  </div>
                  <span className={`${textSize} text-foreground truncate`}>{u.name}</span>
                  <span className={`${textSize} text-muted-foreground/60 ml-auto flex-shrink-0`}>{u.jobTitle}</span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
});

export default UserSelect;
