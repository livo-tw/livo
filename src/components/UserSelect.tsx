import { useState, useRef, useEffect, useId, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useMemberContext } from '@/context/MemberContext';
import { Check, ChevronDown } from 'lucide-react';
import { sortUsersByDept } from '@/lib/department';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

interface UserSelectProps {
  value?: string;
  defaultValue?: string;
  onChange?: (value: string) => void;
  allowEmpty?: boolean;
  emptyLabel?: string;
  className?: string;
  size?: 'sm' | 'md';
  name?: string;
  label?: string;
  required?: boolean;
  disabled?: boolean;
  activeOnly?: boolean;
}

const UserSelect = memo(({ value: controlledValue, defaultValue = '', onChange, allowEmpty = false,
  emptyLabel = '—', className = '', size = 'sm', name, label, required = false, disabled = false,
  activeOnly = false }: UserSelectProps) => {
  const { t } = useTranslation();
  const { users } = useMemberContext();
  const [internalValue, setInternalValue] = useState(defaultValue);
  const value = controlledValue ?? internalValue;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [invalid, setInvalid] = useState(false);
  const id = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = users.find(user => user.id === value);
  const unavailable = !!value && (!selected || (activeOnly && selected.isActive !== true));
  const formValue = unavailable ? '' : value;
  const avatarSize = size === 'sm' ? 'h-5 w-5 text-[7px]' : 'h-6 w-6 text-[8px]';
  const availableUsers = sortUsersByDept(users.filter(user => !activeOnly || user.isActive === true));
  const query = search.trim().toLocaleLowerCase();
  const filteredUsers = availableUsers.filter(user => !query ||
    `${user.name} ${user.jobTitle || ''}`.toLocaleLowerCase().includes(query));
  const changeOpen = (next: boolean) => {
    setOpen(next && !disabled);
    if (!next) setSearch('');
  };
  const select = (next: string) => {
    if (disabled || (next && !availableUsers.some(user => user.id === next))) return;
    if (controlledValue === undefined) setInternalValue(next);
    onChange?.(next);
    setInvalid(false);
    changeOpen(false);
  };
  useEffect(() => { if (disabled) { setOpen(false); setSearch(''); } }, [disabled]);

  return <div className={`min-w-0 ${className}`}>
    {label && <label htmlFor={id} className="mb-1 block text-sm font-medium">{label}{required ? ' *' : ''}</label>}
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button ref={triggerRef} id={id} type="button" role="combobox" disabled={disabled}
          aria-label={label} aria-expanded={open} aria-haspopup="listbox" aria-required={required || undefined}
          aria-invalid={invalid || unavailable || undefined} aria-describedby={unavailable ? `${id}-hint` : undefined}
          onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); changeOpen(true); } }}
          className="flex w-full min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1.5 text-foreground outline-none transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50">
          {selected ? <>
            <span aria-hidden="true" className={`${avatarSize} flex shrink-0 items-center justify-center rounded-full font-bold text-white`} style={{ backgroundColor: selected.color }}>{selected.avatar}</span>
            <span className="truncate text-xs">{selected.name}{selected.isActive === false && <span className="ml-1 text-muted-foreground">({t('common.inactive')})</span>}</span>
          </> : <span className="truncate text-xs text-muted-foreground">{value ? `${t('common.memberUnavailable')} · ${value}` : emptyLabel}</span>}
          <ChevronDown size={12} className="ml-auto shrink-0 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      {open && <PopoverContent align="start" className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[180px] max-w-[calc(100vw-16px)] p-0"
        onOpenAutoFocus={event => { event.preventDefault(); inputRef.current?.focus(); }}
        onCloseAutoFocus={event => {
          event.preventDefault();
          // A second picker may already be focused. Do not steal its focus while closing.
          if (document.activeElement === document.body || document.activeElement === triggerRef.current) triggerRef.current?.focus();
        }}>
        <Command shouldFilter={false} loop label={label ? `${t('common.search')} · ${label}` : t('common.search')}>
          <CommandInput ref={inputRef} value={search} onValueChange={setSearch} aria-label={label ? `${t('common.search')} · ${label}` : t('common.search')}
            placeholder={`${t('common.search')}...`} className="h-9 text-xs" />
          <CommandList aria-label={label || t('common.search')} className="max-h-[min(240px,var(--radix-popover-content-available-height))] p-1">
            {allowEmpty && <CommandItem value="__empty__" onSelect={() => select('')} className="text-xs text-muted-foreground">{emptyLabel}{!value && <Check size={12} className="ml-auto" aria-hidden="true" />}</CommandItem>}
            {filteredUsers.length === 0 && <div role="status" className="px-3 py-3 text-center text-xs text-muted-foreground">{t('common.noResults')}</div>}
            {filteredUsers.map(user => <CommandItem key={user.id} value={user.id} onSelect={() => select(user.id)} className="min-w-0 gap-2 text-xs">
              <span aria-hidden="true" className={`${avatarSize} flex shrink-0 items-center justify-center rounded-full font-bold text-white`} style={{ backgroundColor: user.color }}>{user.avatar}</span>
              <span className="truncate">{user.name}</span><span className="ml-auto truncate text-muted-foreground">{user.jobTitle}</span>
              {value === user.id && <Check size={12} className="shrink-0" aria-hidden="true" />}
            </CommandItem>)}
          </CommandList>
        </Command>
      </PopoverContent>}
    </Popover>
    {/* Native validation and FormData remain in the form; the portal owns no values. */}
    {(name || required) && <select aria-hidden="true" tabIndex={-1} className="sr-only" name={name}
      value={formValue} required={required} disabled={disabled} onChange={event => select(event.target.value)}
      onInvalid={event => { event.preventDefault(); setInvalid(true); triggerRef.current?.focus(); }}>
      <option value="" />{availableUsers.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}
    </select>}
    {unavailable && <p id={`${id}-hint`} className="mt-1 text-xs text-muted-foreground">{t('common.chooseActiveMember')}</p>}
  </div>;
});

export default UserSelect;
