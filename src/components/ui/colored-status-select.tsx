import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';
import { SearchableSelect } from './searchable-select';

export interface ColoredStatusOption<Value extends string = string> {
  value: Value;
  label: string;
  color?: string;
  disabled?: boolean;
}

/** Display only: callers supply the permitted values, labels and status colours. */
export function ColoredStatusSelect<Value extends string>({ label, value, options, displayCurrentOption, onValueChange, disabled, className, variant = 'default' }: {
  label: string;
  value: Value;
  options: readonly ColoredStatusOption<Value>[];
  /** Render the historical current value without adding it to selectable choices. */
  displayCurrentOption?: ColoredStatusOption<Value>;
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
  variant?: 'default' | 'dot';
}) {
  const id = useId();
  const selected = options.find(option => option.value === value)
    || (displayCurrentOption?.value === value ? displayCurrentOption : undefined);
  const dot = variant === 'dot';
  const dotStyle = dot ? { width: 10, height: 10, backgroundColor: selected?.color || '#6B778C' } : undefined;
  // Radix reserves the empty string for no selection. Prefix every value so an
  // explicit "all" option can keep its caller's empty value without collisions.
  const encode = (optionValue: string) => `option:${optionValue}`;
  const content = (option: ColoredStatusOption<Value>) => <span className="flex min-w-0 items-center gap-2">
    {option.color && <span aria-hidden="true" data-status-dot className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />}
    <span className="truncate">{option.label}</span>
  </span>;
  if (options.filter(option => option.value !== '').length > 5) return <div className={cn(dot ? 'min-w-0' : 'min-w-0 space-y-1 text-sm', className)}>
    <label htmlFor={id} className={dot ? 'sr-only' : 'block font-medium'}>{label}</label>
    <SearchableSelect id={id} value={value} displayCurrentOption={displayCurrentOption} disabled={disabled} title={dot ? `${label}: ${selected?.label || value}` : undefined} style={dotStyle}
      className={dot ? 'block shrink-0 rounded-full border-0 p-0 hover:opacity-75 [&>span]:sr-only [&>svg]:hidden' : 'h-10 rounded-md border border-input bg-background px-3 py-2 text-sm'} onChange={event => {
      const option = options.find(item => item.value === event.target.value);
      if (option && !option.disabled) onValueChange(option.value);
    }}>{options.map(option => <option key={option.value} value={option.value} disabled={option.disabled} data-color={option.color}>{option.label}</option>)}</SearchableSelect>
  </div>;
  return <div className={cn(dot ? 'min-w-0' : 'min-w-0 space-y-1 text-sm', className)}>
    <label htmlFor={id} className={dot ? 'sr-only' : 'block font-medium'}>{label}</label>
    <Select value={encode(value)} disabled={disabled} onValueChange={encoded => {
      const option = options.find(item => encode(item.value) === encoded);
      if (option && !option.disabled) onValueChange(option.value);
    }}>
      <SelectTrigger id={id} style={dotStyle} title={dot ? `${label}: ${selected?.label || value}` : undefined}
        className={dot ? 'block min-w-0 shrink-0 rounded-full border-0 p-0 hover:opacity-75 [&>svg]:hidden' : 'min-w-0'}>
        <SelectValue>{dot ? <span className="sr-only">{selected?.label || value}</span> : selected ? content(selected) : value}</SelectValue>
      </SelectTrigger>
      <SelectContent aria-label={label}>
        {options.map(option => <SelectItem key={option.value} value={encode(option.value)} disabled={option.disabled} textValue={option.label}>
          {content(option)}
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
