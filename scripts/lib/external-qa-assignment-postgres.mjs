export function addAssignmentCases({ cases, check, error, auth, quote, json }) {
  const read = (action, input = {}) => `public.livo_qa_external_read(${auth},${quote(action)},${json(input)})`;
  cases.push("RESET ROLE; INSERT INTO auth.users(id,email) VALUES('00000000-0000-0000-0000-000000000013','private@example.com'); SET ROLE service_role;");
  cases.push(`INSERT INTO members(id,name,email,avatar,job_title,is_active,role) VALUES
    ('m-other-project','Example engineer','private@example.com','E','Private title',true,'member'),
    ('eqa-internal-member','Prefix engineer','prefix@example.com','P','Private title',true,'member'),
    ('m-unused-disabled','Unused disabled','disabled@example.com','D','Private title',false,'member');
    UPDATE members SET auth_id='00000000-0000-0000-0000-000000000013' WHERE id='m-other-project';`);
  check('external assignment directory includes an active internal engineer with no QA project participation',
    `${read('members', { projectId: 'p-test' })}->'members' @> '[{"id":"m-other-project","name":"Example engineer","isActive":true}]'::jsonb`);
  check('profile minimal roster includes the same unrelated active internal engineer',
    `${read('profile')}->'members' @> '[{"id":"m-other-project","name":"Example engineer"}]'::jsonb`);
  check('unused inactive internal members are not enumerated',
    `NOT (${read('profile')}->'members' @> '[{"id":"m-unused-disabled"}]'::jsonb)`);
  check('directory exposes no email login Slack or private job title',
    `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${read('members', { projectId: 'p-test' })}->'members') m
      WHERE (m-ARRAY['id','name','avatar','color','jobTitle','isActive'])<>'{}'::jsonb OR COALESCE(m->>'jobTitle','')<>'')
      AND ${read('profile')}::text NOT LIKE '%private@example.com%' AND ${read('profile')}::text NOT LIKE '%Private title%'`);
  check('candidate validation accepts all active internal people through the scoped RPC',
    `${read('people', { projectId: 'p-test', ids: ['m-other-project'] })}='[{"id":"m-other-project"}]'::jsonb`);
  error('directory in an ungranted project is refused', `SELECT ${read('members', { projectId: 'p-other' })}`, 'P0002', 'qa_project_unavailable');
  const base = id => ({ id, workspaceId: 'default', projectId: 'p-test', state: 'new', reporterId: 'eqa-example',
    assigneeId: 'm-other-project', qaOwnerId: 'eqa-example', title: 'Example assignment', actual: 'Example report',
    observedEnvironment: 'Stage', observedVersion: '', steps: '', expected: '', component: '', severity: 'untriaged',
    priority: 3, dueDate: null, fixCycle: 0, fixSummary: '', targets: [], runs: [], taskIds: [], resolution: null,
    resolutionReason: '', duplicateOfId: null, closedAt: null, closedBy: null, reopenedAt: null, holdReason: '',
    reopenReason: '', version: 1, createdAt: '2026-11-04T01:00:00.000Z', updatedAt: '2026-11-04T01:00:00.000Z', handoff: null, customFields: {} });
  const create = (data, entry = 'public.livo_qa_commit') => `${entry}(${auth},${quote(data.id)},${quote(data.id + '-command')},${quote('a'.repeat(64))},NULL,'create',${json(data)},${json({ type: 'create', id: data.id + '-event', recipients: [] })})`;
  check('published commit OID owner and ACL stay unchanged',
    "(SELECT p.oid=b.oid AND p.proowner=b.proowner AND p.proacl=b.proacl FROM pg_proc p CROSS JOIN qa_test.commit_identity b WHERE p.oid='public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)'::regprocedure)");
  check('normal and copied base RPC are service-only',
    "NOT has_function_privilege('authenticated','public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.livo_qa_commit(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE') AND NOT has_function_privilege('authenticated','public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE') AND NOT has_function_privilege('anon','public.livo_qa_commit_assignment_base(uuid,text,text,text,integer,text,jsonb,jsonb)','EXECUTE')");
  error('an existing OID-dependent normal entry cannot bypass the assignment guard',
    `SELECT ${create({ ...base('assignment-via-dependency'), assigneeId: 'eqa-example' }, 'qa_test.commit_by_dependency')}`, '22023', 'qa_member_unavailable');
  const first = base('assignment-internal');
  check('external reporter creates a bug assigned to any active internal engineer', `${create(first)}->>'assigneeId'='m-other-project'`);
  check('a legitimate eqa-prefixed internal member remains selectable and assignable',
    `${read('members', { projectId: 'p-test' })}->'members' @> '[{"id":"eqa-internal-member","isActive":true}]'::jsonb AND ${create({ ...base('assignment-prefix-internal'), assigneeId: 'eqa-internal-member' })}->>'assigneeId'='eqa-internal-member'`);
  error('a frontend classification flag cannot make an external QA identity an internal RD',
    `SELECT ${create({ ...base('assignment-fake-kind'), assigneeId: 'eqa-example', isExternal: false })}`, '22023', 'qa_member_unavailable');
  check('internal RD and external QA ownership remain distinct',
    `(SELECT assignee_id='m-other-project' AND qa_owner_id='eqa-example' FROM qa_issues WHERE id='assignment-internal')`);
  error('external reporter cannot select an inactive internal engineer',
    `SELECT ${create({ ...base('assignment-disabled'), assigneeId: 'm-unused-disabled' })}`, '22023', 'qa_member_unavailable');
  error('an external QA account cannot become a new internal repair assignee',
    `SELECT ${create({ ...base('assignment-external-rd'), assigneeId: 'eqa-example' })}`, '22023', 'qa_member_unavailable');
  error('expanded directory does not grant another project for creation',
    `SELECT ${create({ ...base('assignment-other-project'), projectId: 'p-other' })}`, '42501', 'qa_forbidden');
  check('rejected assignments never create an aggregate or command receipt',
    `NOT EXISTS(SELECT 1 FROM qa_issues WHERE id IN ('assignment-disabled','assignment-external-rd','assignment-other-project'))
      AND NOT EXISTS(SELECT 1 FROM qa_commands WHERE issue_id IN ('assignment-disabled','assignment-external-rd','assignment-other-project'))`);
  const start = `public.livo_qa_commit('00000000-0000-0000-0000-000000000013'::uuid,'assignment-internal','assignment-start-command',${quote('c'.repeat(64))},1,'command',
    (SELECT data || '{"state":"in_progress","version":2,"updatedAt":"2026-11-04T01:01:00.000Z"}'::jsonb FROM qa_issues WHERE id='assignment-internal'),
    '{"type":"start_fix","id":"assignment-start-event","recipients":[]}'::jsonb)`;
  check('newly assigned internal RD can start the bug through normal member authorization', `${start}->>'state'='in_progress'`);
  const update = `public.livo_qa_commit(${auth},'assignment-internal','assignment-update-command',${quote('b'.repeat(64))},2,'command',
    (SELECT data || '{"assigneeId":"m-member","version":3,"updatedAt":"2026-11-04T01:01:00.000Z"}'::jsonb FROM qa_issues WHERE id='assignment-internal'),
    '{"type":"update_fields","id":"assignment-update-event","recipients":[]}'::jsonb)`;
  check('external reporter edits the repair assignee to another active internal member', `${update}->>'assigneeId'='m-member'`);
  cases.push("UPDATE members SET is_active=false WHERE id='m-other-project';");
  error('a previously returned candidate is rechecked after deactivation',
    `SELECT ${create(base('assignment-stale-candidate'))}`, '22023', 'qa_member_unavailable');
  cases.push("UPDATE members SET is_active=false WHERE id='m-assignee';");
  cases.push("INSERT INTO qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data) SELECT 'assignment-history-import',project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data || '{\"id\":\"assignment-history-import\"}'::jsonb FROM qa_issues WHERE id='example-stale';");
  check('separate privileged history import retains an inactive recorded owner',
    "(SELECT assignee_id='m-assignee' FROM qa_issues WHERE id='assignment-history-import')");
  check('normal assignment guard is cleared after successful and rejected commands',
    "COALESCE(current_setting('livo.qa_assignment_enforce',true),'false')<>'true'");

  check('inactive participants keep their name for visible historical QA',
    `${read('profile')}->'members' @> '[{"id":"m-assignee","isActive":false}]'::jsonb`);
  check('inactive historical participants are not offered for new assignment',
    `NOT (${read('members', { projectId: 'p-test' })}->'members' @> '[{"id":"m-assignee"}]'::jsonb)`);
  cases.push("UPDATE members SET is_active=true WHERE id IN ('m-assignee','m-other-project');");
}
