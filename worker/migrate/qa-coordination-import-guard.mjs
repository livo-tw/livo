export function assertQaCoordinationImportSafe(readRows) {
 for(const table of ['qa_project_coordination','qa_coordination_commands','qa_issues']) {
  const rows=readRows(table);if(!Array.isArray(rows))throw new Error('Invalid QA coordination import data');
  if(rows.length>0)
   throw new Error('qa_coordination_history_requires_restore');
 }
}
