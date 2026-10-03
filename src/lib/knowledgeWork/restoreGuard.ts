/** Team JSON backups deliberately exclude KB/private storage. They cannot
 * restore a workspace containing any knowledge without losing its ACL/history. */
// Union of PostgreSQL and D1 content/import ledgers, including imports which
// have not produced a KB page. Exclude the seeded invalidation-only work clock.
export const KNOWLEDGE_RESTORE_TABLES = [
  'kb_pages','kb_revisions','kb_attachments','kb_comments','kb_publications','kb_source_links','kb_work_receipts','kb_work_events',
  'kb_source_snapshots','kb_checklist_items','kb_work_links','kb_workflow_commands','kb_navigation_preferences',
  'knowledge_import_policy','knowledge_import_jobs','knowledge_import_sources','knowledge_import_cleanup_cursors',
  'knowledge_import_files','knowledge_import_usage_reconciliations','knowledge_import_maintenance_state',
] as const;
export function hasKnowledgeRestoreData(input: Record<string, unknown>): boolean {
  return KNOWLEDGE_RESTORE_TABLES.some(name => Object.prototype.hasOwnProperty.call(input,name)
    && (!Array.isArray(input[name]) || (input[name] as unknown[]).length > 0));
}
export function assertKnowledgeRestoreSafe(input: Record<string, unknown>, live?: Record<string, unknown>): void {
  if(live && KNOWLEDGE_RESTORE_TABLES.some(name=>!Object.prototype.hasOwnProperty.call(live,name)||!Array.isArray(live[name]))) throw new Error('knowledge_requires_server_restore');
  if (hasKnowledgeRestoreData(input) || (live && hasKnowledgeRestoreData(live))) throw new Error('knowledge_requires_server_restore');
}
