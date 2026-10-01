import { latestKnowledgeRevisions, validateKnowledgeTree, type KnowledgeLink } from '../../../worker/src/knowledgeModel';
import { randomUUID } from '@/lib/generateId';

type Row = Record<string, unknown>;
export function seedKnowledgeMock(db: Record<string, Row[]>) {
  const now = new Date().toISOString();
  const base: Row = { body: '<p>Keep useful team notes here. Add a page for each process and a child page for examples.</p>',
    parent_id: null, project_id: null, sort_order: 0, is_archived: false, admin_only: false,
    created_by: 'm-001', updated_by: 'm-001', created_at: now, updated_at: now, version: 1 };
  db.kb_pages = [
    { ...base, id: 'kb-demo-guide', title: 'Team handbook' },
    { ...base, id: 'kb-demo-howto', parent_id: 'kb-demo-guide', title: 'How to share a decision', body: '<p>Describe the decision, the reason and the next step. Example: the fictional Aurora team reviews its guide every Friday.</p>' },
    ...(db.projects?.[0] ? [{ ...base, id: 'kb-demo-project', project_id: db.projects[0].id, title: 'Project reference', body: '<p>Store project setup steps, working agreements and reference files here.</p>' }] : []),
  ];
  db.kb_attachments = [];
  db.kb_revisions = [];
}

export function knowledgeMockDefaults(table: string, row: Row): Row {
  if (table !== 'kb_pages') return row;
  return { body: '', project_id: null, parent_id: null, sort_order: 0, is_archived: false, admin_only: false,
    updated_at: row.created_at, version: 1, ...row };
}

export function knowledgeMockUpdate(db: Record<string, Row[]>, previous: Row, patch: Row): Row {
  const next: Row = { ...previous, ...patch, version: Number(previous.version) + 1, updated_at: new Date().toISOString() };
  validateKnowledgeTree(db.kb_pages.map(p => p.id === next.id ? next : p) as unknown as KnowledgeLink[]);
  const revision = { id: randomUUID(), page_id: previous.id, body: previous.body,
    created_by: previous.updated_by, created_at: previous.updated_at, version: Number(previous.version) };
  const same = [...db.kb_revisions.filter(r => r.page_id === previous.id), revision];
  db.kb_revisions = [...db.kb_revisions.filter(r => r.page_id !== previous.id), ...latestKnowledgeRevisions(same as (Row & { version: number })[])];
  return next;
}
