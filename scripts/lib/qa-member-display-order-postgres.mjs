/** Real PostgreSQL ordering/scope checks, using only disposable fixture rows. */
export function addMemberDisplayOrderCases({ cases, check, error, auth, admin, quote, json }) {
  const page = (offset = 0, search = '', who = admin) => `public.livo_qa_member_display_page(${who},'p-test',${quote(search)},${offset})`;
  const external = (action, input = {}) => `public.livo_qa_external_read(${auth},${quote(action)},${json(input)})`;
  check('direct migration rerun preserves function OIDs owners and ACLs',
    `(SELECT count(*) FROM qa_test.member_order_identity b JOIN pg_proc p ON p.oid=b.oid
      WHERE p.proowner=b.proowner AND p.proacl IS NOT DISTINCT FROM b.proacl)=2`);
  check('direct migration rerun does not populate or mutate the member roster',
    `(SELECT count(*) FROM members)=(SELECT max(roster_count) FROM qa_test.member_order_identity)`);
  check('member display page is service-only',
    `has_function_privilege('service_role','public.livo_qa_member_display_page(uuid,text,text,integer)','EXECUTE')
      AND NOT has_function_privilege('authenticated','public.livo_qa_member_display_page(uuid,text,text,integer)','EXECUTE')
      AND NOT has_function_privilege('anon','public.livo_qa_member_display_page(uuid,text,text,integer)','EXECUTE')`);
  cases.push(`INSERT INTO members(id,name,role,is_active,sort_order) VALUES
    ('qa-order-first','Zulu first','member',true,1),
    ('qa-order-tie-a','Zulu tie','member',true,2),
    ('qa-order-tie-b','Alpha tie','member',true,2),
    ('eqa-qa-order-internal','Opaque internal','member',true,3),
    ('qa-order-null','Percent %_ literal','member',true,NULL),
    ('qa-order-after','Alpha later','member',true,100),
    ('qa-order-disabled','Disabled example','member',false,0);
    INSERT INTO members(id,name,role,is_active,sort_order)
      SELECT 'qa-order-page-'||lpad(n::text,3,'0'),'Reverse '||lpad((121-n)::text,3,'0'),'member',true,10+n
      FROM generate_series(1,120) n;`);
  check('member suggestions use managed rank then opaque id rather than names',
    `${page()}->'members'->0->>'id'='qa-order-first' AND ${page()}->'members'->1->>'id'='qa-order-tie-a' AND ${page()}->'members'->2->>'id'='qa-order-tie-b'`);
  check('member pagination is globally ordered before the 100-row boundary',
    `((${page()}->'members')||(${page(100)}->'members'))=(SELECT jsonb_agg(jsonb_build_object('id',id,'name',name,'sortOrder',COALESCE(sort_order,99),'isExternal',false) ORDER BY COALESCE(sort_order,99),id) FROM members WHERE is_active)
      AND ${page()}->>'hasMore'='true' AND ${page(100)}->>'hasMore'='false'`);
  check('literal search preserves null rank fallback and does not treat percent or underscore as wildcards',
    `${page(0, '%_')}->'members'='[{"id":"qa-order-null","name":"Percent %_ literal","sortOrder":99,"isExternal":false}]'::jsonb`);
  check('member display page exposes no login role or profile fields',
    `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${page()}->'members') p WHERE p-ARRAY['id','name','sortOrder','isExternal']<>'{}'::jsonb)`);
  error('external principal cannot use internal suggestions', `SELECT ${page(0, '', auth)}`, '42501', 'qa_forbidden');
  error('invalid offset is rejected', `SELECT ${page(-1)}`, '22023', 'qa_invalid_request');
  error('unknown project is rejected', `SELECT public.livo_qa_member_display_page(${admin},'unknown-project','',0)`, 'P0002', 'qa_project_unavailable');
  error('authenticated sessions cannot call service-only display page',
    `SET LOCAL ROLE authenticated; SELECT ${page()}`, '42501', 'permission denied');
  check('scoped external member pages follow the same internal rank before external roster',
    `${external('members', { projectId: 'p-test' })}->'members'->0->>'id'='qa-order-first'
      AND ${external('members', { projectId: 'p-test' })}->'members'->1->>'id'='qa-order-tie-a'
      AND ${external('members', { projectId: 'p-test' })}->'members'->2->>'id'='qa-order-tie-b'`);
  check('opaque eqa-looking internal identity retains internal order metadata',
    `${external('profile')}->'members' @> '[{"id":"eqa-qa-order-internal","sortOrder":3,"isExternal":false}]'::jsonb`);
  check('external identity metadata has no fictitious member rank',
    `EXISTS(SELECT 1 FROM jsonb_array_elements(${external('profile')}->'members') p WHERE p->>'id'='eqa-example' AND p->'isExternal'='true'::jsonb AND NOT p?'sortOrder')`);
  check('unused inactive identities remain excluded from both suggestion directories',
    `NOT (${external('profile')}->'members' @> '[{"id":"qa-order-disabled"}]'::jsonb)
      AND NOT (${page()}->'members' @> '[{"id":"qa-order-disabled"}]'::jsonb)`);
  check('sort metadata does not widen minimal profile disclosure',
    `NOT EXISTS(SELECT 1 FROM jsonb_array_elements(${external('profile')}->'members') p
      WHERE p-ARRAY['id','name','avatar','color','jobTitle','isActive','sortOrder','isExternal']<>'{}'::jsonb)`);
  // Preserve the inherited suite's fixtures and counts after these isolated cases.
  cases.push("DELETE FROM members WHERE id LIKE 'qa-order-%' OR id='eqa-qa-order-internal';");
}
