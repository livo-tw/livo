import DOMPurify from 'dompurify';

/** Sanitize first, then keep web references from replacing the knowledge page. */
export function renderKnowledgeHtml(html: string): string {
  const fragment = DOMPurify.sanitize(html, { RETURN_DOM_FRAGMENT: true });
  for (const anchor of fragment.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href')?.trim() || '';
    if (/^(https?:)?\/\//i.test(href)) {
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
    }
  }
  const container = document.createElement('div');
  container.append(fragment);
  return container.innerHTML;
}
