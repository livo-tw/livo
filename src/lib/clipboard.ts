/**
 * Copy text to the clipboard; resolves true when it worked.
 *
 * navigator.clipboard exists only in secure contexts (HTTPS or localhost). On
 * a self-hosted install opened as http://<server>:3000 it is undefined, so
 * fall back to selecting a hidden textarea and document.execCommand('copy'),
 * which still works there. The textarea goes inside the open dialog, if any,
 * so a dialog's focus trap does not pull focus (and the selection) away.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window !== 'undefined' && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* permission denied or not focused: try the fallback */
    }
  }
  if (typeof document === 'undefined') return false;
  const host = (document.activeElement?.closest('[role="dialog"]') as HTMLElement | null) ?? document.body;
  const previous = document.activeElement as HTMLElement | null;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.opacity = '0';
  area.style.pointerEvents = 'none';
  host.appendChild(area);
  try {
    area.focus();
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    previous?.focus?.();
  }
}
