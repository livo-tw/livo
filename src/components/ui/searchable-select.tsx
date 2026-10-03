import { forwardRef, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type SelectHTMLAttributes } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { Command, CommandInput, CommandItem, CommandList } from './command';

type Option = { value: string; label: string; group: string; disabled: boolean; color?: string };

/** Native values and validation, with searchable choices when there are more than five. */
export const SearchableSelect = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function SearchableSelect({ children, className, id: suppliedId, onChange, onInvalid, ...props }, forwardedRef) {
    const { t } = useTranslation();
    const generatedId = useId();
    const id = suppliedId || generatedId;
    const nativeRef = useRef<HTMLSelectElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const searchRef = useRef<HTMLInputElement>(null);
    useImperativeHandle(forwardedRef, () => nativeRef.current!, []);
    const [options, setOptions] = useState<Option[]>([]);
    const [nativeValue, setNativeValue] = useState('');
    const [label, setLabel] = useState('');
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState('');
    const [invalid, setInvalid] = useState(false);
    const labelProp = useRef(props['aria-label']); labelProp.current = props['aria-label'];
    const searchable = !props.multiple && options.filter(option => option.value !== '').length > 5;
    useLayoutEffect(() => {
      const select = nativeRef.current;
      if (!select) return;
      const sync = () => {
      const next = Array.from(select.options, option => ({ value: option.value, label: option.label,
        group: option.parentElement instanceof HTMLOptGroupElement ? option.parentElement.label : '',
        disabled: option.disabled || (option.parentElement instanceof HTMLOptGroupElement && option.parentElement.disabled),
        color: option.dataset.color || option.style.color || undefined }));
      setOptions(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      setNativeValue(select.value);
      const labelElement = select.labels?.[0] || triggerRef.current?.labels?.[0];
      const copy = labelElement?.cloneNode(true) as HTMLElement | undefined;
      copy?.querySelectorAll('select,button,input,textarea').forEach(control => control.remove());
      setLabel(labelProp.current || copy?.textContent?.trim() || '');
      };
      sync();
      const observer = new MutationObserver(sync);
      observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'value', 'label', 'style', 'data-color'] });
      const reset = () => queueMicrotask(sync);
      select.form?.addEventListener('reset', reset);
      return () => { observer.disconnect(); select.form?.removeEventListener('reset', reset); };
    }, [children, props.value, props.defaultValue, props['aria-label']]);
    useLayoutEffect(() => { if (props.disabled || !searchable) { setOpen(false); setSearch(''); } }, [props.disabled, searchable]);
    const changeOpen = (next: boolean) => { setOpen(next && !props.disabled); if (!next) setSearch(''); };
    const selected = options.find(option => option.value === (props.value === undefined ? nativeValue : String(props.value)));
    const query = search.trim().toLocaleLowerCase();
    const filtered = options.filter(option => !query || `${option.label} ${option.group}`.toLocaleLowerCase().includes(query));
    const selectOption = (option: Option) => {
      const select = nativeRef.current;
      if (!select || props.disabled || option.disabled || !Array.from(select.options).some(row => row.value === option.value && !row.disabled)) return;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      setInvalid(false);
      changeOpen(false);
    };
    return <>
      <select {...props} ref={nativeRef} id={searchable ? `${id}-native` : id}
        className={searchable ? 'sr-only' : className} aria-hidden={searchable || undefined}
        tabIndex={searchable ? -1 : props.tabIndex}
        onChange={event => { setNativeValue(event.target.value); setInvalid(false); onChange?.(event); }}
        onInvalid={event => { onInvalid?.(event); if (searchable) { event.preventDefault(); setInvalid(true); triggerRef.current?.focus(); } }}>
        {children}
      </select>
      {searchable && <Popover open={open} onOpenChange={changeOpen}>
        <PopoverTrigger asChild><button id={id} ref={triggerRef} type="button" role="combobox"
          disabled={props.disabled} aria-label={props['aria-label'] || label || undefined} aria-labelledby={props['aria-labelledby']}
          aria-describedby={props['aria-describedby']} aria-required={props.required || undefined}
          aria-expanded={open} aria-haspopup="listbox" aria-invalid={invalid || props['aria-invalid'] || undefined}
          title={props.title || selected?.label} style={props.style}
          onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); changeOpen(true); } }}
          className={`flex w-full min-w-0 items-center gap-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50 ${className || 'rounded border border-border bg-card px-2 py-1.5 text-sm'}`}>
          {selected?.color && <span aria-hidden="true" data-status-dot className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: selected.color }} />}
          <span className="truncate">{selected?.label || options.find(option => option.value === '')?.label || '—'}</span>
          <ChevronDown size={14} className="ml-auto shrink-0" aria-hidden="true" />
        </button></PopoverTrigger>
        <PopoverContent align="start" className="z-[60] w-[var(--radix-popover-trigger-width)] min-w-[200px] max-w-[calc(100vw-16px)] p-0"
          onOpenAutoFocus={event => { event.preventDefault(); searchRef.current?.focus(); }}
          onCloseAutoFocus={event => { event.preventDefault(); if (document.activeElement === document.body || document.activeElement === triggerRef.current) triggerRef.current?.focus(); }}>
          <Command shouldFilter={false} loop label={label ? `${t('common.search')} · ${label}` : t('common.search')}>
            <CommandInput ref={searchRef} value={search} onValueChange={setSearch}
              aria-label={label ? `${t('common.search')} · ${label}` : t('common.search')} placeholder={`${t('common.search')}...`} />
            <CommandList label={label || undefined} className="max-h-[min(300px,var(--radix-popover-content-available-height))] p-1">
              {filtered.length === 0 && <div role="status" className="px-3 py-3 text-center text-sm text-muted-foreground">{t('common.noResults')}</div>}
              {filtered.map((option, index) => <div key={`${option.group}:${option.value}:${index}`}>
                {option.group && (index === 0 || filtered[index - 1].group !== option.group) && <div className="px-2 pb-1 pt-2 text-xs font-semibold text-muted-foreground">{option.group}</div>}
                <CommandItem value={`choice-${index}`} disabled={option.disabled} onSelect={() => selectOption(option)}>
                  {option.color && <span aria-hidden="true" data-status-dot className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />}
                  <span className="truncate">{option.label}</span>{selected?.value === option.value && <Check size={14} className="ml-auto shrink-0" aria-hidden="true" />}
                </CommandItem>
              </div>)}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>}
    </>;
  });
