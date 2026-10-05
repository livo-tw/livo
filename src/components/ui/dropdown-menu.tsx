import * as React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from '@/lib/utils';

const MenuContext = React.createContext<{ select: () => void; selected: React.MutableRefObject<boolean> } | null>(null);

/** Small action menu built on the app's existing portal/focus/dismiss primitive. */
export function DropdownMenu({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = React.useState(false);
  const selected = React.useRef(false);
  return <MenuContext.Provider value={{ selected, select: () => { selected.current = true; setOpen(false); } }}>
    <Popover open={open} onOpenChange={next => { selected.current = false; setOpen(next); }}>{children}</Popover>
  </MenuContext.Provider>;
}

export const DropdownMenuTrigger = React.forwardRef<React.ElementRef<typeof PopoverTrigger>, React.ComponentPropsWithoutRef<typeof PopoverTrigger>>(
  (props, ref) => <PopoverTrigger {...props} ref={ref} aria-haspopup="menu" />,
);
DropdownMenuTrigger.displayName = 'DropdownMenuTrigger';

export function DropdownMenuContent({ className, children, ...props }: React.ComponentPropsWithoutRef<typeof PopoverContent>) {
  const context = React.useContext(MenuContext);
  const ref = React.useRef<HTMLDivElement>(null);
  const options = () => Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled),[role="menuitemradio"]:not(:disabled)') || []);
  return <PopoverContent {...props} ref={ref} role="menu" className={cn('z-[60] w-auto min-w-40 p-1', className)}
    onOpenAutoFocus={event => { event.preventDefault(); options()[0]?.focus(); }}
    onCloseAutoFocus={event => { if (context?.selected.current) event.preventDefault(); }}
    onKeyDown={event => {
      const items = options(), at = items.indexOf(document.activeElement as HTMLButtonElement);
      if (!items.length || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 :
        (at + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus();
    }}>{children}</PopoverContent>;
}

/** A "menuitemradio" role (with aria-checked) marks one choice of a group. */
export function DropdownMenuItem({ className, onSelect, children, role = 'menuitem', ...props }: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect' | 'role'> & { onSelect?: () => void; role?: 'menuitem' | 'menuitemradio' }) {
  const context = React.useContext(MenuContext);
  return <button {...props} type="button" role={role} className={cn('flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm outline-none hover:bg-accent focus:bg-accent disabled:pointer-events-none disabled:opacity-50', className)}
    onClick={event => { props.onClick?.(event); if (!event.defaultPrevented) { context?.select(); onSelect?.(); } }}>{children}</button>;
}
