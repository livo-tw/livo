import { useId } from 'react';
import { cn } from '@/lib/utils';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

export interface ColoredStatusOption<Value extends string = string> {
  value: Value;
  label: string;
  color?: string;
  disabled?: boolean;
}

/** Display only: callers supply the permitted values, labels and status colours. */
export function ColoredStatusSelect<Value extends string>({ label, value, options, onValueChange, disabled, className }: {
  label: string;
  value: Value;
  options: readonly ColoredStatusOption<Value>[];
  onValueChange: (value: Value) => void;
  disabled?: boolean;
  className?: string;
}) {
  const id = useId();
  const selected = options.find(option => option.value === value);
  // Radix reserves the empty string for no selection. Prefix every value so an
  // explicit "all" option can keep its caller's empty value without collisions.
  const encode = (optionValue: string) => `option:${optionValue}`;
  const content = (option: ColoredStatusOption<Value>) => <span className="flex min-w-0 items-center gap-2">
    {option.color && <span aria-hidden="true" data-status-dot className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: option.color }} />}
    <span className="truncate">{option.label}</span>
  </span>;
  return <div className={cn('min-w-0 space-y-1 text-sm', className)}>
    <label htmlFor={id} className="block font-medium">{label}</label>
    <Select value={encode(value)} disabled={disabled} onValueChange={encoded => {
      const option = options.find(item => encode(item.value) === encoded);
      if (option && !option.disabled) onValueChange(option.value);
    }}>
      <SelectTrigger id={id} className="min-w-0"><SelectValue>{selected ? content(selected) : value}</SelectValue></SelectTrigger>
      <SelectContent aria-label={label}>
        {options.map(option => <SelectItem key={option.value} value={encode(option.value)} disabled={option.disabled} textValue={option.label}>
          {content(option)}
        </SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
