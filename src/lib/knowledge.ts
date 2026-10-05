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

/** True when the page or one of its ancestors is a private draft. */
export function knowledgeInsidePrivateDraft(pages: Pick<KnowledgePage, 'id' | 'parent_id' | 'private_draft_owner_id'>[], id: string | null | undefined): boolean {
  const seen = new Set<string>();
  for (let cursor = id || null; cursor && !seen.has(cursor) && seen.size < 10;) {
    seen.add(cursor);
    const page = pages.find(p => p.id === cursor);
    if (!page) return false;
    if (page.private_draft_owner_id) return true;
    cursor = page.parent_id;
  }
  return false;
}

/** Turn a refused page deletion into a message key the reader can act on. */
export function knowledgeDeleteErrorKey(failure: unknown): string {
  const message = failure && typeof failure === 'object' && 'message' in failure ? String(failure.message) : String(failure ?? '');
  // PostgreSQL names the constraint; the parent link means child pages remain.
  if (/parent_id_fkey/i.test(message)) return 'kb_has_children';
  // Any other remaining reference (SQLite does not name the constraint, so hidden child pages land here too).
  if (/foreign key|knowledge_conflict/i.test(message)) return 'kb_delete_blocked';
  return message.match(/\bkb_(?!pages\b)[a-z_]+/)?.[0] || 'kb_failed';
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

/**
 * The pages a scoped knowledge directory lists. With a sidebar project or product line
 * selected, pages of no project are left out, except the member's own private drafts
 * (they belong to no project and would otherwise be unreachable). Unscoped: every page.
 */
export function knowledgeDirectoryPages<T extends { project_id: string | null; private_draft_owner_id?: string | null }>(pages: T[], scoped: boolean, memberId: string | null | undefined): T[] {
  if (!scoped) return pages;
  return pages.filter(page => page.project_id || (!!memberId && page.private_draft_owner_id === memberId));
}

