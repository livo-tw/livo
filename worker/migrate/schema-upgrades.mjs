// Dependency-injected so the same probes can run against disposable SQLite.
// Call only after the tenancy migration has completed successfully.
export async function applyPostTenantSchemaUpgrades({ queryRows, applyFile, log = () => {} }) {
  const tables = await queryRows("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_deployments','qa_issues')");
  const table = name => tables.find(row => row.name === name)?.sql;
  if (!table('tasks')) return [];
  const taskColumns = await queryRows('PRAGMA table_info(tasks)');
  if (!taskColumns.some(column => column.name === 'workspace_id')) throw new Error('Schema upgrades require completed tenancy');
  const applied = [];
  if (table('task_deployments') && /\bCHECK\s*\(\s*environment\s+IN\b/i.test(table('task_deployments'))) {
    const columns = await queryRows('PRAGMA table_info(task_deployments)');
    const expected = ['workspace_id', 'id', 'task_id', 'environment', 'status', 'deploy_date'].sort();
    if (JSON.stringify(columns.map(column => column.name).sort()) !== JSON.stringify(expected)) {
      throw new Error('Unexpected task_deployments columns; refusing a rebuild that could lose data');
    }
    await applyFile('deployment-environments.sql');
    const rows = await queryRows("SELECT sql FROM sqlite_master WHERE type='table' AND name='task_deployments'");
    if (rows.length !== 1 || /\bCHECK\s*\(\s*environment\s+IN\b/i.test(rows[0].sql)) {
      throw new Error('Deployment environment schema upgrade did not complete');
    }
    applied.push('deployment-environments.sql');
    log('[deployment-environments] fixed environment CHECK removed; existing rows preserved.');
  }
  if (table('qa_issues') && !/'verified'/i.test(table('qa_issues'))) {
    const columns = await queryRows('PRAGMA table_info(qa_issues)');
    const expected = ['workspace_id','id','project_id','state','assignee_id','qa_owner_id','reporter_id','title','version','updated_at','data'].sort();
    if (JSON.stringify(columns.map(column=>column.name).sort()) !== JSON.stringify(expected)) throw new Error('Unexpected qa_issues columns; refusing a rebuild that could lose data');
    await applyFile('qa-status-semantics.sql');
    const rows = await queryRows("SELECT sql FROM sqlite_master WHERE type='table' AND name='qa_issues'");
    if (rows.length !== 1 || !/'verified'/i.test(rows[0].sql)) throw new Error('QA status schema upgrade did not complete');
    applied.push('qa-status-semantics.sql');
    log('[qa-status-semantics] QA state CHECK upgraded; existing rows preserved.');
  }
  return applied;
}
