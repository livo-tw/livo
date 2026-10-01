/** Pure hierarchy rules shared by the browser, mock and Worker. */
export interface KnowledgeLink {
  id: string;
  parent_id: string | null;
  project_id: string | null;
  sort_order: number;
  title: string;
}

export const KNOWLEDGE_DEPTH = 3;
export const KNOWLEDGE_REVISIONS = 20;

export function validateKnowledgeTree(pages: KnowledgeLink[]): void {
  const byId = new Map(pages.map(p => [p.id, p]));
  for (const page of pages) {
    const seen = new Set([page.id]);
    let current = page;
    while (current.parent_id) {
      const parent = byId.get(current.parent_id);
      if (!parent || parent.project_id !== page.project_id) throw new Error('kb_invalid_parent');
      if (seen.has(parent.id)) throw new Error('kb_cycle');
      seen.add(parent.id);
      if (seen.size > KNOWLEDGE_DEPTH) throw new Error('kb_depth');
      current = parent;
    }
  }
}

export function latestKnowledgeRevisions<T extends { version: number }>(revisions: T[]): T[] {
  return [...revisions].sort((a, b) => b.version - a.version).slice(0, KNOWLEDGE_REVISIONS);
}
