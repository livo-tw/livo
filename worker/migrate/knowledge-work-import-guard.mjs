/** A local migration export is not an ACL-aware knowledge restoration format. */
// PostgreSQL source tables only. D1 storage ledgers have no PostgreSQL equivalent.
// The seeded kb_work_clock is an invalidation counter, not restorable content.
export const KNOWLEDGE_IMPORT_SOURCE_TABLES = [
  'kb_pages','kb_revisions','kb_attachments','kb_comments','kb_publications','kb_source_links','kb_work_receipts','kb_work_events',
  'kb_source_snapshots','kb_checklist_items','kb_work_links','kb_workflow_commands','kb_navigation_preferences',
  'knowledge_import_policy','knowledge_import_jobs','knowledge_import_sources','knowledge_import_cleanup_cursors',
];
export function assertKnowledgeImportSafe(readRows) {
  const rows=KNOWLEDGE_IMPORT_SOURCE_TABLES.map(readRows);
  if(rows.some(v=>!Array.isArray(v)))throw new Error('Invalid knowledge import data');
  if(rows.some(v=>v.length))throw new Error('knowledge_requires_server_restore: Use verified pg_dump and private storage backup or a dedicated ACL-preserving migration; knowledge versions, private drafts and staged imports cannot be discarded.');
}
