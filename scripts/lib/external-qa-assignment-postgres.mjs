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
      WHERE (m-ARRAY['id','name','avatar','color','jobTitle','isActive','isExternal','sortOrder'])<>'{}'::jsonb OR COALESCE(m->>'jobTitle','')<>'')
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

  // Paired aggregates differ only in reporter identity. Exercise the shipped
  // commit wrapper, actual internal actors and the same required deployment.
  const internalAuth = n => `'00000000-0000-0000-0000-${String(n).padStart(12, '0')}'::uuid`;
  const commit = (who, data, type, expected = null, recipients = []) =>
    `public.livo_qa_commit(${who},${quote(data.id)},${quote(data.id + '-' + type + '-command')},${quote('d'.repeat(64))},${expected === null ? 'NULL' : expected},${quote(type === 'create' ? 'create' : 'command')},${json(data)},${json({ type, id: data.id + '-' + type + '-event', recipients })})`;
  for (const [origin, reporter, reporterAuth] of [['internal', 'm-member', internalAuth(1)], ['external', 'eqa-example', auth]]) {
    const initial = { ...base('parity-' + origin), reporterId: reporter, assigneeId: 'm-assignee', qaOwnerId: 'm-qa' };
    const started = { ...initial, state: 'in_progress', version: 2 };
    const target = { id: 'parity-target-' + origin, environment: 'Stage', component: 'API', build: 'example-build', required: true,
      deployedAt: null, deployedBy: null, deploymentEvidence: '' };
    const submitted = { ...started, state: 'verification', version: 3, fixCycle: 1, fixSummary: 'Example repair', targets: [target] };
    const deployed = { ...submitted, version: 4, targets: [{ ...target, deployedAt: initial.updatedAt, deployedBy: 'm-assignee' }] };
    const closed = { ...deployed, version: 5, state: 'closed', resolution: 'fixed', closedAt: initial.updatedAt, closedBy: 'm-qa', runs: [
      { id: 'parity-run-' + origin, sequence: 1, fixCycle: 1, targetId: target.id, environment: 'Stage', component: 'API', build: 'example-build',
        result: 'pass', note: '', testerId: 'm-qa', createdAt: initial.updatedAt },
    ] };
    check(`${origin} reporter: create preserves the assigned internal RD and QA`,
      `${commit(reporterAuth, initial, 'create', null, ['m-assignee', 'm-qa'])}->>'id'=${quote(initial.id)}`);
    check(`${origin} reporter: internal RD starts through the real commit wrapper`,
      `${commit(internalAuth(4), started, 'start_fix', 1)}=${json(started)}`);
    check(`${origin} reporter: internal RD submits the same required repair target`,
      `${commit(internalAuth(4), submitted, 'submit_fix', 2, ['m-qa'])}=${json(submitted)}`);
    error(`${origin} reporter: assigned RD cannot impersonate the internal verifier`,
      `SELECT ${commit(internalAuth(4), closed, 'record_verification', 3)}`, '42501', 'member_inactive');
    check(`${origin} reporter: internal RD records a real deployment`,
      `${commit(internalAuth(4), deployed, 'record_deployment', 3, ['m-qa'])}=${json(deployed)}`);
    check(`${origin} reporter: internal QA PASS atomically closes with the actual verifier`,
      `${commit(internalAuth(5), closed, 'record_verification', 4, ['m-assignee'])}=${json(closed)}`);
    check(`${origin} reporter: persisted aggregate and receipt retain the real evidence`,
      `(SELECT state='closed' AND version=5 AND data=${json(closed)} FROM qa_issues WHERE id=${quote(initial.id)})
       AND (SELECT count(*)=5 FROM qa_commands WHERE issue_id=${quote(initial.id)})
       AND (SELECT count(*)=5 FROM qa_events WHERE issue_id=${quote(initial.id)})`);
    check(`${origin} reporter: internal actionable notification recipients are unchanged`,
      `(SELECT count(*)=5 AND bool_and(task_id IS NULL) AND count(*) FILTER(WHERE recipient_id='m-assignee')=2 AND count(*) FILTER(WHERE recipient_id='m-qa')=3
        FROM notifications WHERE CASE WHEN type='qa_update' THEN content::jsonb->>'issueId' END=${quote(initial.id)})`);
    const uploadId = 'parity-upload-' + origin, storagePath = `default/${initial.id}/${uploadId}`;
    cases.push(`INSERT INTO qa_uploads(id,issue_id,actor_id,file_name,mime_type,size,storage_path,created_at,expires_at)
      VALUES(${quote(uploadId)},${quote(initial.id)},'m-assignee','example.txt','text/plain',7,${quote(storagePath)},now(),now()+interval '1 hour');
      INSERT INTO storage.objects(bucket_id,name,metadata) VALUES('qa-evidence',${quote(storagePath)},'{"size":7,"mimetype":"text/plain"}');`);
    check(`${origin} reporter: internal upload finalization preserves actual uploader on the same private bucket`,
      `(WITH finalized AS MATERIALIZED (SELECT public.livo_qa_finalize_upload(${internalAuth(4)},${quote(uploadId)}) AS item)
        SELECT item->>'uploaded_by'='m-assignee' AND item->>'issue_id'=${quote(initial.id)}
          AND item->>'storage_path'=${quote(storagePath)} FROM finalized)`);
    error(`${origin} reporter: an unrelated internal member cannot delete the completed bug`,
      `SELECT public.livo_qa_delete(${internalAuth(13)},${quote(initial.id)},5)`, '42501', 'qa_forbidden');
    check(`${origin} reporter: an internal admin deletes through the same guarded entry point`,
      `(WITH deleted AS MATERIALIZED (SELECT public.livo_qa_delete(${internalAuth(2)},${quote(initial.id)},5) AS item)
        SELECT item->>'deleted'='true' AND item->'paths' @> ${json([storagePath])} FROM deleted)`);
  }

  // Historical filter identities are labels for internal QA, never new member
  // accounts, external project grants or repair-assignment candidates.
  const filter = (who, projects = 'NULL', offset = 0) =>
    `public.livo_qa_filter_people(${who},${projects},${offset})`;
  cases.push(`INSERT INTO external_qa_accounts(id,auth_id,name,is_active) VALUES
    ('eqa-filter-history','00000000-0000-0000-0000-000000000021','Example historical tester',false),
    ('eqa-filter-other','00000000-0000-0000-0000-000000000022','Example other-project tester',true),
    ('eqa-filter-comment','00000000-0000-0000-0000-000000000023','Example comment author',true);
    INSERT INTO external_qa_project_grants(account_id,project_id) VALUES('eqa-filter-other','p-other');`);
  const historical = { ...base('filter-history-example'), reporterId: 'eqa-filter-history', assigneeId: 'm-assignee', qaOwnerId: 'm-qa' };
  cases.push(`INSERT INTO qa_issues(id,project_id,state,assignee_id,qa_owner_id,reporter_id,title,version,updated_at,data)
    VALUES(${quote(historical.id)},'p-test','new','m-assignee','m-qa','eqa-filter-history',${quote(historical.title)},1,${quote(historical.updatedAt)},${json(historical)});
    INSERT INTO qa_comments(id,issue_id,actor_id,body,created_at)
    VALUES('filter-comment-example',${quote(historical.id)},'eqa-filter-comment','Example historical comment',now());`);
  for (const [role, who] of [['member', internalAuth(1)], ['admin', internalAuth(2)], ['super_admin', internalAuth(3)]]) {
    check(`${role} uses the same scoped external reporter and QA-owner filter directory`,
      `${filter(who, "ARRAY['p-test']")}->'members' @> '[{"id":"eqa-example","isActive":true},{"id":"eqa-filter-history","isActive":false}]'::jsonb`);
  }
  check('filter RPC is service-only without member or anonymous direct access',
    "has_function_privilege('service_role','public.livo_qa_filter_people(uuid,text[],integer)','EXECUTE') AND NOT has_function_privilege('authenticated','public.livo_qa_filter_people(uuid,text[],integer)','EXECUTE') AND NOT has_function_privilege('anon','public.livo_qa_filter_people(uuid,text[],integer)','EXECUTE')");
  check('filter directory does not return unrelated projects or comment-only identities',
    `NOT (${filter(internalAuth(1), "ARRAY['p-test']")}->'members' @> '[{"id":"eqa-filter-other"}]'::jsonb)
     AND NOT (${filter(internalAuth(1), "ARRAY['p-test']")}->'members' @> '[{"id":"eqa-filter-comment"}]'::jsonb)`);
  check('filter labels expose only id name and live display status',
    `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${filter(internalAuth(1))}->'members') person
      WHERE (person-ARRAY['id','name','isActive'])<>'{}'::jsonb)`);
  check('filter empty scope returns no identities while all-project scope contains readable projects',
    `${filter(internalAuth(1), 'ARRAY[]::text[]')}->'members'='[]'::jsonb
     AND ${filter(internalAuth(1))}->'members' @> '[{"id":"eqa-filter-other"},{"id":"eqa-filter-history"}]'::jsonb`);
  check('filter directory in another readable project excludes the first-project historical reporter',
    `${filter(internalAuth(1), "ARRAY['p-other']")}->'members' @> '[{"id":"eqa-filter-other"}]'::jsonb
     AND NOT (${filter(internalAuth(1), "ARRAY['p-other']")}->'members' @> '[{"id":"eqa-filter-history"}]'::jsonb)`);
  cases.push("UPDATE members SET is_qa_admin=true WHERE id='m-other-project';");
  check('QA administrator keeps the ordinary internal display scope',
    `${filter(internalAuth(13), "ARRAY['p-test']")}->'members' @> '[{"id":"eqa-filter-history","isActive":false}]'::jsonb`);
  cases.push("UPDATE members SET is_qa_admin=false,is_active=false WHERE id='m-other-project';");
  error('inactive internal caller cannot reuse the filter directory', `SELECT ${filter(internalAuth(13))}`, '42501', 'qa_forbidden');
  cases.push("UPDATE members SET is_active=true WHERE id='m-other-project';");
  error('external login cannot use the internal filter directory', `SELECT ${filter(auth)}`, '42501', 'qa_forbidden');
  error('negative filter offset is rejected', `SELECT ${filter(internalAuth(1), 'NULL', -1)}`, '22023', 'qa_invalid_request');
  error('duplicate filter scope identifiers are rejected', `SELECT ${filter(internalAuth(1), "ARRAY['p-test','p-test']")}`, '22023', 'qa_invalid_request');
  cases.push("UPDATE system_settings SET value=jsonb_set(value,'{qa}','false'::jsonb) WHERE key='feature_toggles';");
  error('disabled QA does not return internal filter identities', `SELECT ${filter(internalAuth(1))}`, '42501', 'qa_disabled');
  cases.push("UPDATE system_settings SET value=jsonb_set(value,'{qa}','true'::jsonb) WHERE key='feature_toggles';");
}
