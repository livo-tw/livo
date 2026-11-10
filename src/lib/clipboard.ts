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

/** Copy a card link as a titled HTML anchor, with its canonical URL as plain text. */
export async function copyCardLink(url: string, label: string): Promise<boolean> {
  let href: string;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return false;
    href = parsed.toString();
  } catch { return false; }
  if (typeof document === 'undefined') return false;
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.textContent = label.trim() || href;
  const html = anchor.outerHTML;
  if (window.isSecureContext && navigator.clipboard?.write && typeof ClipboardItem !== 'undefined') {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/plain': new Blob([href], { type: 'text/plain' }),
        'text/html': new Blob([html], { type: 'text/html' }),
      })]);
      return true;
    } catch { /* Permission or HTML support unavailable: use the HTTP-safe path. */ }
  }

  const previous = document.activeElement as HTMLElement | null;
  const host = previous?.closest('[role="dialog"]') ?? document.body;
  const selection = window.getSelection();
  const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
  const endpoints = selection && { anchor: selection.anchorNode, anchorOffset: selection.anchorOffset, focus: selection.focusNode, focusOffset: selection.focusOffset };
  const input = previous instanceof HTMLInputElement || previous instanceof HTMLTextAreaElement ? previous : null;
  const inputSelection = input && { start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  editor.setAttribute('aria-hidden', 'true');
  editor.tabIndex = -1;
  Object.assign(editor.style, { position: 'fixed', top: '0', left: '0', opacity: '0', pointerEvents: 'none' });
  editor.appendChild(anchor);
  host.appendChild(editor);
  let transferred = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    try {
      event.clipboardData.setData('text/plain', href);
      event.clipboardData.setData('text/html', html);
      event.preventDefault();
      transferred = true;
    } catch { /* Older browsers can still copy the plain URL below. */ }
  };
  const selectEditor = () => {
    editor.focus({ preventScroll: true });
    const range = document.createRange(); range.selectNodeContents(editor);
    selection?.removeAllRanges(); selection?.addRange(range);
  };
  document.addEventListener('copy', onCopy, true);
  try {
    selectEditor();
    const copied = document.execCommand('copy');
    if (!copied || transferred) return copied;
    // If an old browser cannot set both MIME types, retain a usable URL rather
    // than leaving only the title as text. Keep the same focus/selection guard.
    editor.textContent = href;
    selectEditor();
    return document.execCommand('copy');
  } catch { return false; }
  finally {
    document.removeEventListener('copy', onCopy, true);
    editor.remove();
    try {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) if (range.startContainer.isConnected && range.endContainer.isConnected) selection.addRange(range);
        if (ranges.length === 1 && endpoints?.anchor?.isConnected && endpoints.focus?.isConnected && selection.setBaseAndExtent) {
          selection.setBaseAndExtent(endpoints.anchor, endpoints.anchorOffset, endpoints.focus, endpoints.focusOffset);
        }
      }
    } catch { /* The original element/range can have been removed by a copy listener. */ }
    if (input?.isConnected && inputSelection && inputSelection.start !== null && inputSelection.end !== null) {
      try { input.setSelectionRange(inputSelection.start, inputSelection.end, inputSelection.direction ?? undefined); }
      catch { /* Non-text input types have no text selection. */ }
    }
  }
}
