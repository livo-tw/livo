// Dependency-injected so the same probes can run against disposable SQLite.
// Call only after the tenancy migration has completed successfully.
export async function applyPostTenantSchemaUpgrades({ queryRows, applyFile, log = () => {} }) {
  const tables = await queryRows("SELECT name,sql FROM sqlite_master WHERE type='table' AND name IN ('tasks','task_deployments','qa_issues','members')");
  const table = name => tables.find(row => row.name === name)?.sql;
  if (!table('tasks')) return [];
  const taskColumns = await queryRows('PRAGMA table_info(tasks)');
  if (!taskColumns.some(column => column.name === 'workspace_id')) throw new Error('Schema upgrades require completed tenancy');
  const applied = [];
  if (table('members')) {
    const columns = await queryRows('PRAGMA table_info(members)');
    if (!columns.some(column => column.name === 'workspace_id')) throw new Error('Member capability upgrade requires completed tenancy');
    if (!columns.some(column => column.name === 'is_qa_admin')) {
      await applyFile('qa-admin-capability.sql');
      const updated = await queryRows('PRAGMA table_info(members)');
      if (!updated.some(column => column.name === 'is_qa_admin')) throw new Error('QA capability schema upgrade did not complete');
      applied.push('qa-admin-capability.sql');
      log('[qa-admin-capability] scoped flag added; existing roles and dependent rows preserved.');
    }
  }
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
  const approvalColumns = await queryRows('PRAGMA table_info(approval_requests)');
  if (approvalColumns.length) {
    const expectedNew = ['version','steps_snapshot','rule_snapshot'];
    const present = expectedNew.filter(name => approvalColumns.some(column => column.name === name));
    if (present.length && present.length !== expectedNew.length) throw new Error('Partial approval schema upgrade; refusing to guess its state');
    const actionColumns = await queryRows('PRAGMA table_info(approval_actions)');
    const actionPresent = ['command_id','request_version'].filter(name => actionColumns.some(column => column.name === name));
    if ((!present.length && actionPresent.length) || (present.length && actionPresent.length !== 2)) throw new Error('Partial approval action schema upgrade');
    const inconsistent = await queryRows(`SELECT r.id FROM approval_requests r LEFT JOIN tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
      WHERE r.status='pending' AND (t.id IS NULL OR t.current_approval_id IS NOT r.id OR t.approval_status IS NOT 'pending_approval' OR t.status_id<>r.from_status)
      UNION ALL SELECT task_id FROM approval_requests WHERE status='pending' GROUP BY workspace_id,task_id HAVING count(*)>1
      UNION ALL SELECT t.id FROM tasks t WHERE (t.current_approval_id IS NOT NULL OR t.approval_status='pending_approval') AND NOT EXISTS(
        SELECT 1 FROM approval_requests r WHERE r.workspace_id=t.workspace_id AND r.task_id=t.id AND r.id=t.current_approval_id AND r.status='pending') LIMIT 1`);
    if (inconsistent.length) throw new Error('Inconsistent pending approvals; repair explicitly before migration, no rows were removed');
    if (!present.length) { await applyFile('approval-command-alters.sql'); applied.push('approval-command-alters.sql'); }
    await applyFile('approval-commands.sql');
    applied.push('approval-commands.sql');
    log('[approval-commands] atomic command guards installed; existing history preserved.');
    const bindingColumns=await queryRows('PRAGMA table_info(external_account_bindings)');
    if(bindingColumns.length&&!bindingColumns.some(column=>column.name==='verified_by')){
      await applyFile('approval-binding-alter.sql');applied.push('approval-binding-alter.sql');
    }
  }
  const planningColumns=['due_date_kind','due_date_version','due_date_change_reason','due_date_changed_by'];
  const existing=planningColumns.filter(name=>taskColumns.some(column=>column.name===name));
  if (existing.length && existing.length!==planningColumns.length) throw new Error('Partial task planning schema; refusing to guess');
  if (!existing.length) { await applyFile('task-reminder-alters.sql'); applied.push('task-reminder-alters.sql'); }
  await applyFile('task-reminder-preferences.sql');
  applied.push('task-reminder-preferences.sql');
  const verified=await queryRows('PRAGMA table_info(tasks)');
  if (!planningColumns.every(name=>verified.some(column=>column.name===name))) throw new Error('Task planning schema upgrade did not complete');
  const workTasks=['assignee_revision','reviewer_revision','assignee_acknowledged_at','reviewer_acknowledged_at'];
  const workChecks=await queryRows('PRAGMA table_info(task_checks)'), workTodos=await queryRows('PRAGMA table_info(task_todos)');
  const workTaskColumns=await queryRows('PRAGMA table_info(tasks)');
  const workPresent=[...workTasks.map(name=>workTaskColumns.some(column=>column.name===name)),workChecks.some(column=>column.name==='version'),workTodos.some(column=>column.name==='version')];
  if(workPresent.some(Boolean)&&!workPresent.every(Boolean))throw new Error('Partial task work schema; refusing to guess');
  if(!workPresent.some(Boolean)){await applyFile('task-work-alters.sql');applied.push('task-work-alters.sql');}
  await applyFile('task-work-commands.sql');applied.push('task-work-commands.sql');
  if(table('qa_issues')) {
    const qaColumns=await queryRows('PRAGMA table_info(qa_commands)');
    if(qaColumns.length&&!qaColumns.some(c=>c.name==='actor_auth_id')) {await applyFile('qa-coordination-alters.sql');applied.push('qa-coordination-alters.sql');}
    if(qaColumns.length){await applyFile('qa-coordination.sql');applied.push('qa-coordination.sql');}
  }
  const knowledgeColumns=await queryRows('PRAGMA table_info(kb_pages)');
  if(knowledgeColumns.length){
    const revisions=await queryRows('PRAGMA table_info(kb_revisions)');
    const present=[...['private_draft_owner_id','document_metadata'].map(name=>knowledgeColumns.some(c=>c.name===name)),
      ...['title','document_metadata'].map(name=>revisions.some(c=>c.name===name))];
    if(present.some(Boolean)&&!present.every(Boolean))throw new Error('Partial knowledge work schema; refusing to guess');
    if(!present.some(Boolean)){await applyFile('knowledge-work-alters.sql');applied.push('knowledge-work-alters.sql');}
    await applyFile('knowledge-work.sql');applied.push('knowledge-work.sql');
  }
  await applyFile('release-workspace.sql');applied.push('release-workspace.sql');
  return applied;
}
