const literal=value=>`'${String(value).replaceAll("'","''")}'`;
const json=value=>`${literal(JSON.stringify(value))}::jsonb`;

export function appendQaFieldCases({sql,check,error,role,commit,save,base,auth,workflow,permissionFloorSql}) {
  auth.qaAdmin='00000000-0000-0000-0000-000000000006';
  sql.push(`INSERT INTO members(id,auth_id,role,is_qa_admin) VALUES('m-qa-admin',${literal(auth.qaAdmin)},'member',true);`);
  const definition=(id,fieldType,extra={})=>({id,fieldName:id,fieldType,isRequired:false,isEnabled:true,sortOrder:0,...extra});
  const fields=[definition('summary','text'),definition('notes','textarea'),definition('count','number'),
    definition('choice','select',{options:['Alpha','Beta']}),definition('date','date'),definition('flag','boolean')];
  const catalog={version:1,fields};
  const saveFields=(actor,value=catalog)=>`public.livo_qa_save_field_configuration(${literal(auth[actor])}::uuid,${json(value)})`;
  const validate=(value,previous={})=>`public.livo_qa_validate_custom_fields(${json(value)},${json(previous)})`;
  for(const actor of ['qaAdmin','admin','super']) {
    check(`${actor} manages QA field catalog through scoped RPC`,`${saveFields(actor)}=${json(catalog)}`);
    check(`${actor} manages QA workflow through scoped RPC`,`${save(actor)}=${json(workflow)}`);
  }
  error('ordinary member cannot manage QA fields',`SELECT ${saveFields('member')}`,'42501','member_inactive');
  error('QA capability does not grant issue ownership',`SELECT ${commit('qaAdmin',{...base,id:'manual-member',state:'failed',version:10},'set_state','command',9)}`,'42501','member_inactive');
  for(const dbRole of ['anon','authenticated']) {
    role(dbRole);
    error(`${dbRole} cannot call QA fields RPC directly`,`SELECT ${saveFields('super')}`,'42501');
  }
  role('service_role');
  const invalids=[['null',null],['array',[]],['wrong version',{...catalog,version:'1'}],['unknown root',{...catalog,extra:true}],
    ['too many fields',{version:1,fields:Array.from({length:51},(_,i)=>definition(`f${i}`,'text'))}],
    ...[
      ['duplicate id',[fields[0],fields[0]]],['unknown key',[{...fields[0],extra:true}]],
      ['invalid id',[{...fields[0],id:'0bad'}]],['blank name',[{...fields[0],fieldName:'\u3000'}]],
      ['long Unicode name',[{...fields[0],fieldName:'😀'.repeat(61)}]],['unknown type',[{...fields[0],fieldType:'user'}]],
      ['string required',[{...fields[0],isRequired:'false'}]],['null enabled',[{...fields[0],isEnabled:null}]],
      ['fraction order',[{...fields[0],sortOrder:0.5}]],['large order',[{...fields[0],sortOrder:100001}]],
      ['select empty',[{...fields[3],options:[]}]],['duplicate options',[{...fields[3],options:['A','A']}]],
      ['blank option',[{...fields[3],options:[' ']}]],['nonselect options',[{...fields[0],options:['A']}]],
    ].map(([name,value])=>[name,{version:1,fields:value}])];
  for(const [name,value] of invalids) error(`field catalog rejects ${name}`,`SELECT ${saveFields('qaAdmin',value)}`,'22023','qa_invalid_field_configuration');
  error('catalog field identities cannot be deleted',`SELECT ${saveFields('qaAdmin',{version:1,fields:[]})}`,'22023','qa_field_identity_immutable');
  error('catalog field types cannot change',`SELECT ${saveFields('qaAdmin',{version:1,fields:fields.map(f=>f.id==='summary'?{...f,fieldType:'number'}:f)})}`,'22023','qa_field_identity_immutable');
  const validValues={summary:'A',notes:'Details',count:0,choice:'Alpha',date:'2028-02-29',flag:false};
  sql.push(`SELECT ${validate(validValues)};`);
  check('all six custom scalar types accept valid values',`true`);
  for(const [name,value] of [
    ['text length',{summary:'x'.repeat(4001)}],['textarea length',{notes:'x'.repeat(20001)}],
    ['number string',{count:'0'}],['boolean number',{flag:0}],['unknown select',{choice:'Missing'}],
    ['invalid leap day',{date:'2027-02-29'}],['invalid month',{date:'2028-13-01'}],['invalid date syntax',{date:'2028-2-01'}],
    ['nested value',{summary:{nested:true}}],
  ]) error(`custom values reject ${name}`,`SELECT ${validate(value)}`,'22023','qa_invalid_custom_field_value');
  error('unknown new custom field is unavailable',`SELECT ${validate({unknown:'new'})}`,'22023','qa_custom_field_unavailable');
  sql.push(`SELECT ${validate({unknown:'legacy'},{unknown:'legacy'})};`);
  check('unchanged unknown custom value is retained',`true`);
  const retired={version:1,fields:fields.map(f=>f.id==='choice'?{...f,options:['Beta']}:f.id==='summary'?{...f,isEnabled:false}:f)};
  check('QA admin may retire fields and select options',`${saveFields('qaAdmin',retired)}=${json(retired)}`);
  sql.push(`SELECT ${validate({summary:'Legacy',choice:'Alpha'},{summary:'Legacy',choice:'Alpha'})};`);
  check('unchanged disabled field and retired option are retained',`true`);
  error('changing disabled field is rejected',`SELECT ${validate({summary:'Changed'},{summary:'Legacy'})}`,'22023','qa_custom_field_unavailable');
  const required={version:1,fields:fields.map(f=>['count','flag'].includes(f.id)?{...f,isRequired:true}:f)};
  check('QA admin may make fields required',`${saveFields('qaAdmin',required)}=${json(required)}`);
  sql.push(`SELECT ${validate({count:0,flag:false})};`);
  check('required values accept zero and false',`true`);
  error('required custom values reject absence',`SELECT ${validate({})}`,'22023','qa_custom_field_required');
  error('required custom values reject null',`SELECT ${validate({count:null,flag:false})}`,'22023','qa_custom_field_required');
  error('create requires configured custom values',`SELECT ${commit('member',{...base,id:'required-create'})}`,'22023','qa_custom_field_required');
  const withValues={...base,id:'custom-value-issue',customFields:validValues};
  check('create persists current configured custom values',`${commit('member',withValues)}=${json(withValues)}`);
  error('edit validates custom scalar type',`SELECT ${commit('member',{...withValues,version:2,customFields:{...validValues,flag:'false'}},'edit','command',1)}`,'22023','qa_invalid_custom_field_value');
  const manual={...base,id:'manual-member',state:'failed',version:10,assigneeId:'m-assignee',qaOwnerId:'m-qa'};
  check('manual state ignores newly required custom values',`${commit('member',manual,'set_state','command',9)}=${json(manual)}`);
  sql.push("UPDATE members SET is_active=false WHERE id='m-qa-admin';");
  error('inactive QA admin cannot manage fields',`SELECT ${saveFields('qaAdmin')}`,'42501','member_inactive');
  error('inactive QA admin cannot manage workflow',`SELECT ${save('qaAdmin')}`,'42501','member_inactive');
  sql.push("UPDATE members SET is_active=true,is_qa_admin=false WHERE id='m-qa-admin';");
  error('revoked QA capability cannot manage fields',`SELECT ${saveFields('qaAdmin')}`,'42501','member_inactive');
  sql.push("UPDATE members SET is_qa_admin=true WHERE id='m-qa-admin'; UPDATE system_settings SET value='{\"qa\":false}' WHERE key='feature_toggles';");
  error('disabled QA rejects field management',`SELECT ${saveFields('qaAdmin')}`,'42501','qa_disabled');
  sql.push("UPDATE system_settings SET value='{\"qa\":true,\"slackActions\":true}' WHERE key='feature_toggles';");
  for(const actor of ['member','qaAdmin','admin','super']) {
    role('authenticated');
    sql.push(`SET "request.jwt.claim.sub"=${literal(auth[actor])};`);
    for(const [name,statement] of [
      ['update',"UPDATE system_settings SET value='{}' WHERE key='qa_custom_fields'"],
      ['delete',"DELETE FROM system_settings WHERE key='qa_custom_fields'"],
      ['rename',"UPDATE system_settings SET key='other' WHERE key='qa_custom_fields'"],
    ]) error(`${actor} cannot bypass QA field RPC by ${name}`,statement,'42501','qa_fields_server_only');
  }
  role('service_role');
  error('service cannot delete an existing field catalog',"DELETE FROM system_settings WHERE key='qa_custom_fields'",'22023','qa_field_identity_immutable');
  error('service cannot store malformed field catalog',"UPDATE system_settings SET value='{}' WHERE key='qa_custom_fields'",'22023','qa_invalid_field_configuration');
  // Exercise the capability column trigger despite a deliberately permissive
  // fixture grant, then load the real global permission floor for boundary tests.
  role('postgres');
  sql.push('GRANT SELECT,INSERT,UPDATE ON members TO authenticated;');
  for(const actor of ['member','qaAdmin','admin']) {
    role('authenticated');
    sql.push(`SET "request.jwt.claim.sub"=${literal(auth[actor])};`);
    error(`${actor} cannot grant QA capability`,"UPDATE members SET is_qa_admin=true WHERE id='m-member'",'42501','qa_admin_assignment_forbidden');
    error(`${actor} cannot create a QA administrator`,"INSERT INTO members(id,role,is_qa_admin) VALUES('forged-qa-admin','member',true)",'42501','qa_admin_assignment_forbidden');
  }
  sql.push("SET \"request.jwt.claim.role\"='service_role'; SET \"request.jwt.claim.sub\"='';");
  error('forged service claim cannot grant QA capability',"UPDATE members SET is_qa_admin=true WHERE id='m-member'",'42501','qa_admin_assignment_forbidden');
  sql.push(`SET "request.jwt.claim.role"=''; SET "request.jwt.claim.sub"=${literal(auth.super)}; UPDATE members SET is_qa_admin=true WHERE id='m-member';`);
  check('super administrator can grant QA capability',"(SELECT is_qa_admin FROM members WHERE id='m-member')");
  sql.push("UPDATE members SET is_qa_admin=false WHERE id='m-member';");
  if(permissionFloorSql) {
    role('postgres'); sql.push(permissionFloorSql,'ALTER TABLE members ENABLE ROW LEVEL SECURITY; ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;');
    for(const actor of ['member','qaAdmin']) {
      role('authenticated'); sql.push(`SET "request.jwt.claim.sub"=${literal(auth[actor])};`);
      check(`${actor} stays outside global administrator role`,`NOT public.is_livo_admin() AND NOT public.is_livo_super()`);
      error(`${actor} cannot create global settings`,"INSERT INTO system_settings(key,value) VALUES('global-capability-test','{}')",'42501');
      sql.push("UPDATE system_settings SET value='{}' WHERE key='feature_toggles';");
      check(`${actor} cannot mutate feature toggles`,"(SELECT value FROM system_settings WHERE key='feature_toggles')='{\"qa\":true,\"slackActions\":true}'::jsonb");
    }
    role('service_role');
    check('QA capability RPC still works with global permission floor',`${saveFields('qaAdmin',required)}=${json(required)}`);
  }
}
