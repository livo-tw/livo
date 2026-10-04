import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';

export function knowledgePageUrl(id: string, origin = window.location.origin, base = import.meta.env.BASE_URL): string {
  const url = new URL(base, origin);
  url.searchParams.set('kb', id);
  return url.toString();
}

/** A portable plain-text copy keeps headings, lists, links, tables and source notes. */
export function knowledgePageText(title: string, body: string): string {
  const container = document.createElement('div');
  container.innerHTML = renderKnowledgeHtml(body);
  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof HTMLElement)) return Array.from(node.childNodes).map(walk).join('');
    const text = Array.from(node.childNodes).map(walk).join('');
    if (node.tagName === 'BR') return '\n';
    if (node.tagName === 'IMG') return node.getAttribute('alt') ? `[${node.getAttribute('alt')}]` : '';
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') || '';
      return href && href !== text.trim() ? `${text} (${href})` : text;
    }
    if (node.tagName === 'LI') {
      const list = node.parentElement;
      const number = list?.tagName === 'OL' ? Number(list.getAttribute('start') || 1) + Array.from(list.children).indexOf(node) : null;
      return `${number === null ? '•' : `${number}.`} ${text.trim()}\n`;
    }
    if (['TD', 'TH'].includes(node.tagName)) return `${text.trim()}\t`;
    if (['P', 'DIV', 'SECTION', 'ARTICLE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TR', 'BLOCKQUOTE', 'PRE', 'DETAILS', 'SUMMARY'].includes(node.tagName)) return `${text.trim()}\n\n`;
    return text;
  };
  const text = walk(container).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${title.trim()}\n\n${text}`.trim();
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);

export function knowledgePrintHtml(page: { title: string; body: string }, labels: { scope: string; updated: string; copyNotice: string }): string {
  const body = document.createElement('div');
  body.innerHTML = renderKnowledgeHtml(page.body);
  // A collapsed source/details block is still part of the saved document.
  body.querySelectorAll('details').forEach(details => { details.open = true; });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob: https: http:; style-src 'unsafe-inline';"><title>${escapeHtml(page.title)}</title><style>
    @page { size:A4; margin:18mm 16mm; }
    body { color:#161a22; background:#fff; font:12pt/1.7 'Microsoft JhengHei','PingFang TC','Noto Sans CJK TC',sans-serif; margin:0; overflow-wrap:anywhere; }
    h1 { font-size:22pt; line-height:1.35; margin:0 0 10pt; } h2,h3,h4 { break-after:avoid; line-height:1.45; }
    .meta { color:#525a66; font-size:9pt; margin-bottom:22pt; padding-bottom:12pt; border-bottom:1px solid #dde1e7; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; font-size:10pt; } th,td { border:1px solid #d3d7de; padding:6pt; vertical-align:top; }
    thead { display:table-header-group; } tr,img,pre,blockquote { break-inside:avoid; } img { max-width:100%; max-height:220mm; height:auto; object-fit:contain; }
    pre { white-space:pre-wrap; overflow-wrap:anywhere; font-size:10pt; } a { color:#2458aa; } p,li { orphans:3; widows:3; }
    footer { margin-top:24pt; border-top:1px solid #dde1e7; padding-top:10pt; font-size:9pt; color:#525a66; }
  </style></head><body><header><h1>${escapeHtml(page.title)}</h1><div class="meta">LIVO · ${escapeHtml(labels.scope)}<br>${escapeHtml(labels.updated)}</div></header><article>${body.innerHTML}</article><footer>${escapeHtml(labels.copyNotice)}</footer></body></html>`;
}

/** Uses the browser's local print-to-PDF, with no public upload or third-party service. */
export async function printKnowledgePage(html: string): Promise<void> {
  const frame = document.createElement('iframe');
  frame.title = 'LIVO PDF'; frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('sandbox', 'allow-same-origin allow-modals');
  Object.assign(frame.style, { position: 'fixed', left: '-10000px', top: '0', width: '800px', height: '1100px', border: '0' });
  const loaded = new Promise<void>((resolve, reject) => {
    frame.onload = () => resolve(); frame.onerror = () => reject(new Error('print_failed'));
  });
  frame.srcdoc = html;
  document.body.appendChild(frame);
  try {
    await loaded;
    const target = frame.contentWindow;
    if (!target) throw new Error('print_failed');
    await target.document.fonts?.ready;
    await Promise.all(Array.from(target.document.images).map(image => image.complete ? Promise.resolve() : new Promise<void>(resolve => {
      const timeout = window.setTimeout(resolve, 4000);
      image.onload = image.onerror = () => { clearTimeout(timeout); resolve(); };
    })));
    target.addEventListener('afterprint', () => frame.remove(), { once: true });
    target.focus(); target.print();
    // Some browsers omit afterprint. Never keep a private export document indefinitely.
    window.setTimeout(() => frame.remove(), 60000);
  } catch (error) { frame.remove(); throw error; }
}
