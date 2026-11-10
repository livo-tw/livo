import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { copyCardLink } from '@/lib/clipboard';
import { qaDeepLinkUrl } from '@/lib/appDeepLink';

const url = 'https://livo.example.com/demo/?task=saved-task';
const label = 'EX-12 · Example card';
let exec: ReturnType<typeof vi.fn<() => boolean>>;
let clipboard: Map<string, string>;
let previousUrl: string;

beforeEach(() => {
  previousUrl = window.location.href;
  clipboard = new Map<string, string>();
  vi.stubGlobal('isSecureContext', false);
  exec = vi.fn(() => {
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => clipboard.set(type, value) } });
    document.dispatchEvent(event);
    return true;
  });
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec });
});
afterEach(() => {
  document.body.replaceChildren(); window.getSelection()?.removeAllRanges();
  window.history.replaceState({}, '', previousUrl);
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('card link clipboard formats', () => {
  it('copies a titled HTML anchor and the canonical URL on plain HTTP', async () => {
    await expect(copyCardLink(url, label)).resolves.toBe(true);
    expect(clipboard.get('text/plain')).toBe(url);
    const html = new DOMParser().parseFromString(clipboard.get('text/html')!, 'text/html');
    expect(html.querySelector('a')?.textContent).toBe(label);
    expect(html.querySelector('a')?.href).toBe(url);
    expect(exec).toHaveBeenCalledExactlyOnceWith('copy');
    expect(document.querySelector('[contenteditable]')).toBeNull();
  });

  it('escapes untrusted card titles and URL attribute content instead of copying executable HTML', async () => {
    const title = 'EX-1 · <img src=x onerror="alert(1)"> & "quotes"';
    const href = 'https://livo.example.com/?task=one&other=%22%3E%3Cscript%3E';
    await copyCardLink(href, title);
    const html = new DOMParser().parseFromString(clipboard.get('text/html')!, 'text/html');
    expect(html.querySelector('a')?.textContent).toBe(title);
    expect(html.querySelector('a')?.href).toBe(href);
    expect(html.querySelector('img, script, [onerror]')).toBeNull();
    expect(html.body.children).toHaveLength(1);
  });

  it.each(['javascript:alert(1)', 'data:text/html,example', 'https://name:secret@example.com/task'])('rejects unsafe card URLs: %s', async href => {
    await expect(copyCardLink(href, label)).resolves.toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('copies inside the active dialog and preserves the input focus and backward selection', async () => {
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    const input = document.createElement('textarea'); input.value = 'unfinished comment'; dialog.append(input); document.body.append(dialog);
    input.focus(); input.setSelectionRange(2, 8, 'backward');
    const send = exec.getMockImplementation()!;
    exec.mockImplementation(() => {
      expect(document.activeElement?.closest('[role="dialog"]')).toBe(dialog);
      return send();
    });
    await copyCardLink(url, label);
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 8, 'backward']);
    expect(dialog.querySelector('[contenteditable]')).toBeNull();
  });

  it('restores the original document text selection after copying', async () => {
    const text = document.createElement('p'); text.textContent = 'existing selection'; document.body.append(text);
    const range = document.createRange(); range.setStart(text.firstChild!, 2); range.setEnd(text.firstChild!, 10);
    const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
    const selected = selection.toString();
    await copyCardLink(url, label);
    expect(selection.toString()).toBe(selected);
    expect(selection.anchorNode).toBe(text.firstChild);
    expect(selection.anchorOffset).toBe(2);
  });

  it('reports a refused copy and still restores focus and removes the temporary editor', async () => {
    const input = document.createElement('input'); document.body.append(input); input.focus();
    exec.mockImplementation(() => { throw new Error('Denied'); });
    await expect(copyCardLink(url, label)).resolves.toBe(false);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[contenteditable]')).toBeNull();
  });

  it('retains a usable plain URL when a legacy browser cannot set clipboard MIME data', async () => {
    const selected: string[] = [];
    exec.mockImplementation(() => { selected.push(window.getSelection()?.toString() || ''); return true; });
    await expect(copyCardLink(url, label)).resolves.toBe(true);
    expect(selected).toEqual([label, url]);
  });

  it('uses ClipboardItem when supported, with separate HTML and plain blobs', async () => {
    vi.stubGlobal('isSecureContext', true);
    class Item { constructor(public data: Record<string, Blob>) {} }
    vi.stubGlobal('ClipboardItem', Item);
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    await expect(copyCardLink(url, label)).resolves.toBe(true);
    const data = (write.mock.calls[0][0][0] as Item).data;
    const read = (blob: Blob) => new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsText(blob);
    });
    expect(await read(data['text/plain'])).toBe(url);
    expect(await read(data['text/html'])).toContain('EX-12');
    expect(exec).not.toHaveBeenCalled();
  });

  it('falls back to the HTTP-safe path when rich clipboard permission is refused', async () => {
    vi.stubGlobal('isSecureContext', true);
    vi.stubGlobal('ClipboardItem', class { constructor(public data: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write: vi.fn().mockRejectedValue(new Error('Denied')) } });
    await expect(copyCardLink(url, label)).resolves.toBe(true);
    expect(clipboard.get('text/html')).toContain(label);
    expect(clipboard.get('text/plain')).toBe(url);
  });

  it.each(['/', '/demo/'])('builds a clean QA deep link under %s rather than copying the current query', base => {
    vi.stubEnv('BASE_URL', base); window.history.replaceState({}, '', '/?task=old&token=stale#old');
    const href = new URL(qaDeepLinkUrl('saved-id&qa=other'));
    expect(href.pathname).toBe(base);
    expect([...href.searchParams]).toEqual([['qa', 'saved-id&qa=other']]);
    expect(href.hash).toBe('');
  });
});
