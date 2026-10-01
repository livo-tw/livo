import DOMPurify from 'dompurify';
import type { KnowledgePage } from '@/types/knowledge';
export { validateKnowledgeTree } from '../../worker/src/knowledgeModel';

export type KnowledgeNode = KnowledgePage & { children: KnowledgeNode[] };

/** Filtered/archived ancestors do not hide an otherwise visible child. */
export function buildKnowledgeTree(pages: KnowledgePage[]): KnowledgeNode[] {
  const nodes = new Map(pages.map(p => [p.id, { ...p, children: [] as KnowledgeNode[] }]));
  const roots: KnowledgeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parent_id ? nodes.get(node.parent_id) : undefined;
    // Guard against malformed legacy data as well as a self-parent.
    let ancestor = parent;
    const seen = new Set([node.id]);
    while (ancestor && !seen.has(ancestor.id)) {
      seen.add(ancestor.id);
      ancestor = ancestor.parent_id ? nodes.get(ancestor.parent_id) : undefined;
    }
    if (parent && !ancestor && parent.project_id === node.project_id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (items: KnowledgeNode[]) => {
    items.sort((a, b) => a.sort_order - b.sort_order || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
    items.forEach(n => sort(n.children));
  };
  sort(roots);
  return roots;
}

export function knowledgeText(html: string): string {
  const el = document.createElement('div');
  el.innerHTML = DOMPurify.sanitize(html).replace(/<\/(p|div|h[1-6]|li)>|<br\s*\/?\s*>/gi, ' ');
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}

export function knowledgeSnippet(html: string, query: string, length = 140): string {
  const text = knowledgeText(html);
  const match = text.toLocaleLowerCase().indexOf(query.trim().toLocaleLowerCase());
  const start = Math.max(0, match - 40);
  return `${start ? '…' : ''}${text.slice(start, start + length)}${text.length > start + length ? '…' : ''}`;
}

export function searchKnowledge(pages: KnowledgePage[], query: string): KnowledgePage[] {
  const needle = query.trim().toLocaleLowerCase();
  return pages.filter(p => `${p.title}\n${knowledgeText(p.body)}`.toLocaleLowerCase().includes(needle));
}
