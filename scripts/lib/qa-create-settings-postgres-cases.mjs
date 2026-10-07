// SQL assertions against the real livo_qa_commit; caller supplies the typed QA fixture and actual dependencies.
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
const json = value => `${literal(JSON.stringify(value))}::jsonb`;
const auth = { member: '00000000-0000-0000-0000-000000000001', admin: '00000000-0000-0000-0000-000000000002', super: '00000000-0000-0000-0000-000000000003' };
const actorIds = { member: 'm-member', admin: 'm-admin', super: 'm-super' };
const base = { workspaceId: 'default', projectId: 'p-test', state: 'new', assigneeId: null, qaOwnerId: 'm-member', title: 'Example QA create settings', version: 1,
  createdAt: '2026-10-07T00:00:00.000Z', updatedAt: '2026-10-07T00:00:00.000Z', actual: 'Example result', observedEnvironment: 'test', observedVersion: '',
  steps: '', expected: '', component: '', severity: 'untriaged', priority: 3, dueDate: null, fixCycle: 0, targets: [], runs: [], taskIds: [] };
export function buildQaCreateSettingsPostgresCases() {
  const sql = [], labels = [];
  const check = (name, expression) => { labels.push(name); sql.push(`SELECT qa_test.check((${expression}),${literal(name)});`); };
  const error = (name, statement, code, message = '') => { labels.push(name); sql.push(`SELECT qa_test.expect_error(${literal(name)},${literal(statement)},${literal(code)},${literal(message)});`); };
  const role = name => sql.push(`RESET ROLE; SET ROLE ${name};`);
  let serial = 0;
  const input = (patch = {}, actor = 'member') => ({ ...base, id: `create-settings-${++serial}`, reporterId: actorIds[actor], ...patch });
  const commit = (data, actor = 'member', command = `create-settings-command-${++serial}`) => `public.livo_qa_commit(${literal(auth[actor])}::uuid,${literal(data.id)},${literal(command)},${literal('a'.repeat(64))},NULL,'create',${json(data)},${json({ id: `event-${command}`, type: 'created', detail: '', recipients: [...new Set([data.assigneeId, data.qaOwnerId].filter(id => id && id !== actorIds[actor]))] })})`;
  role('postgres');
  sql.push("UPDATE members SET is_active=true WHERE id IN ('m-member','m-admin','m-super','m-assignee','m-qa');");
  sql.push("INSERT INTO system_settings(key,value) VALUES('feature_toggles','{\"qa\":true,\"slackActions\":true}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
  sql.push("INSERT INTO system_settings(key,value) VALUES('deployment_environments','{\"version\":1,\"values\":[\"test\",\"QA\"]}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
  sql.push("INSERT INTO system_settings(key,value) VALUES('qa_custom_fields','{\"version\":1,\"fields\":[]}') ON CONFLICT(key) DO UPDATE SET value=excluded.value;");
  role('service_role');
  const selected = input({ assigneeId: 'm-assignee', qaOwnerId: 'm-qa', priority: 2, dueDate: '2026-11-09' });
  const first = commit(selected, 'member', 'create-settings-stable-command');
  check('create selected settings are atomic', `${first}=${json(selected)}`);
  check('create receipt replay is exact', `${first}=${json(selected)}`);
  check('create receipt replay sends each selected owner only one notification', `(SELECT count(*) FROM notifications WHERE content::jsonb->>'issueId'=${literal(selected.id)} AND recipient_id IN ('m-assignee','m-qa'))=2`);
  check('create replay has one event and receipt', `(SELECT count(*) FROM qa_events WHERE issue_id=${literal(selected.id)})=1 AND (SELECT count(*) FROM qa_commands WHERE issue_id=${literal(selected.id)})=1`);
  for (const actor of ['member', 'admin', 'super']) {
    const data = input({ qaOwnerId: actorIds[actor] }, actor);
    check(`${actor} can report with own QA ownership`, `${commit(data, actor)}=${json(data)}`);
  }
  const empty = input({ assigneeId: null, qaOwnerId: null, dueDate: null });
  check('create explicit unassigned owners remain null', `${commit(empty)}=${json(empty)}`);
  const sameOwner = input({ assigneeId: 'm-qa', qaOwnerId: 'm-qa' });
  check('create accepts the same active repair and QA owner', `${commit(sameOwner)}=${json(sameOwner)}`);
  for (const field of ['assigneeId', 'qaOwnerId']) {
    error(`create rejects unknown ${field}`, `SELECT ${commit(input({ [field]: 'unknown-example' }))}`, '22023', 'qa_member_unavailable');
    error(`create rejects non-string ${field}`, `SELECT ${commit(input({ [field]: { id: 'm-qa' } }))}`, '22023', 'qa_member_unavailable');
  }
  role('postgres'); sql.push("UPDATE members SET is_active=false WHERE id='m-assignee';"); role('service_role');
  for (const field of ['assigneeId', 'qaOwnerId']) error(`create rejects freshly inactive ${field}`, `SELECT ${commit(input({ [field]: 'm-assignee' }))}`, '22023', 'qa_member_unavailable');
  // A direct privileged historical import remains outside this create-RPC contract; no whole-table owner trigger was added.
  const imported = input({ assigneeId: 'm-assignee', qaOwnerId: 'm-assignee', component: 'Historical imported area' });
  sql.push(`INSERT INTO public.qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data) VALUES(${literal(imported.id)},'p-test','new','m-assignee','m-assignee','m-member',${literal(imported.title)},1,${literal(imported.updatedAt)}::timestamptz,${json(imported)});`);
  check('privileged historical insertion retains inactive owner references', `(SELECT data FROM qa_issues WHERE id=${literal(imported.id)})=${json(imported)}`);
  role('postgres'); sql.push("UPDATE members SET is_active=true WHERE id='m-assignee';"); role('service_role');
  for (const priority of [0, 6, 1.5, null, '2']) error(`create rejects priority ${JSON.stringify(priority)}`, `SELECT ${commit(input({ priority }))}`, '22023', 'qa_invalid_priority');
  for (const dueDate of ['2026-02-30', '2026-11-09T00:00:00Z', '', 123, { value: '2026-11-09' }]) error(`create rejects date ${JSON.stringify(dueDate)}`, `SELECT ${commit(input({ dueDate }))}`, '22023', 'qa_invalid_date');
  check('create negatives leave no partial issue', `(SELECT count(*) FROM qa_issues WHERE id LIKE 'create-settings-%')=7`);
  role('postgres');
  check('create migration retains deployment operator authorization', `(SELECT pg_get_functiondef('public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure)) LIKE '%public.livo_is_deployment_queue_operator(actor)%'`);
  for (const dbRole of ['anon', 'authenticated', 'service_role']) check(`create RPC execution grant ${dbRole}`, `has_function_privilege(${literal(dbRole)},'public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE')=${dbRole === 'service_role'}`);
  return { sql: sql.join('\n'), assertionCount: labels.length, labels };
}
