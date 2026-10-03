import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTORS = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * Returns a ref to attach to a modal container.
 * When `isActive` is true, Tab/Shift+Tab keys are trapped inside the container
 * and focus is moved to the first focusable element on open.
 */
export function useFocusTrap(isActive: boolean) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isActive || !containerRef.current) return;

    const container = containerRef.current;
    const getFocusable = () => Array.from(
      container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTORS),
    ).filter(element => element.tabIndex >= 0 && !element.matches(':disabled') && !element.closest('[hidden], [aria-hidden="true"]'));
    const focusable = getFocusable();

    if (focusable.length === 0) return;

    // Move focus into the modal on open
    const previous = document.activeElement as HTMLElement | null;
    if (!container.contains(previous)) focusable[0].focus();

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      // A portaled picker or nested dialog manages its own keyboard focus.
      if (!container.contains(document.activeElement)) return;
      const current = getFocusable();
      if (!current.length) return;
      const first = current[0];
      const last = current[current.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => { document.removeEventListener('keydown', handleKeyDown); if (!container.isConnected && previous?.isConnected) previous.focus(); };
  }, [isActive]);

  return containerRef;
}
