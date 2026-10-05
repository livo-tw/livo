import * as React from 'react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type IconActionProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'aria-label'> & {
  /** Shown on hover and keyboard focus. */
  label: string;
  /** Accessible name when it should say more than the tooltip, e.g. include the page title. */
  ariaLabel?: string;
  pressed?: boolean;
};

/**
 * A toolbar button that shows only its icon; the text appears on hover or focus.
 * Toolbars use it so every action looks the same instead of mixing icons and words.
 */
export const IconAction = React.forwardRef<HTMLButtonElement, IconActionProps>(({ label, ariaLabel, pressed, className, children, ...props }, ref) =>
  <TooltipProvider delayDuration={250}>
    <Tooltip>
      <TooltipTrigger asChild>
        <button ref={ref} type="button" aria-label={ariaLabel || label} aria-pressed={pressed} {...props}
          className={cn('inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11',
            pressed && 'bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary', className)}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">{label}</TooltipContent>
    </Tooltip>
  </TooltipProvider>);
IconAction.displayName = 'IconAction';
