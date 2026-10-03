import { describe, expect, it } from 'vitest';
import { canManageQaConfiguration, parseQaFieldConfiguration, validateQaFieldConfiguration, validateQaCustomFieldValues, type QaFieldConfiguration } from '@/lib/qa/fields';
import { applyQaCommand, canQaCommand, createQaIssue, type QaContext } from '@/lib/qa/domain';
import { mapUser } from '@/context/mappers';
import { getPermissions } from '@/lib/permissions';

const configuration: QaFieldConfiguration = { version: 1, fields: [
  {id:'reason',fieldName:'Reason',fieldType:'text',isRequired:true,isEnabled:true,sortOrder:0},
  {id:'browser',fieldName:'Browser',fieldType:'select',options:['One','Two'],isRequired:false,isEnabled:true,sortOrder:1},
] };
const ctx: QaContext = {actor:{id:'reporter',role:'member'},workspaceId:'default',now:'2026-10-03T00:00:00Z',newId:()=> 'generated',memberIds:new Set(['reporter','outsider']),projectIds:new Set(['project']),taskIds:new Set()};
const input = {projectId:'project',title:'Example bug',actual:'Unexpected result',observedEnvironment:'Stage'};

describe('QA custom field schema and scoped capability',()=>{
  it('keeps QA configuration privilege separate from global role and issue participation',()=>{
    expect(canManageQaConfiguration({role:'member'})).toBe(false);
    for(const actor of [{role:'member',qaAdmin:true},{role:'admin'},{role:'super_admin'}]) expect(canManageQaConfiguration(actor)).toBe(true);
    const issue=createQaIssue(input,'issue',ctx);
    expect(canQaCommand(issue,{id:'outsider',role:'member',qaAdmin:true},'set_state')).toBe(false);
    const user=mapUser({id:'u',name:'Example',avatar:'E',role:'member',job_title:'QA',color:'#000000',email:'qa@example.com',is_active:true,sort_order:1,auth_id:null,is_qa_admin:true});
    expect(user).toMatchObject({role:'member',qaAdmin:true});
    expect(getPermissions(user.role).canManageMembers).toBe(false);
  });
  it('rejects malformed catalogs and removal or type changes while allowing disable/rename/reorder',()=>{
    expect(parseQaFieldConfiguration(undefined)).toEqual({version:1,fields:[]});
    for(const raw of ['{',{}, {version:2,fields:[]}, {...configuration,fields:[...configuration.fields,configuration.fields[0]]}]) expect(()=>parseQaFieldConfiguration(raw)).toThrow('qa_invalid_field_configuration');
    expect(()=>validateQaFieldConfiguration({version:1,fields:[]},configuration)).toThrow('qa_field_identity_immutable');
    expect(()=>validateQaFieldConfiguration({...configuration,fields:configuration.fields.map(f=>f.id==='reason'?{...f,fieldType:'number'}:f)},configuration)).toThrow('qa_field_identity_immutable');
    expect(validateQaFieldConfiguration({...configuration,fields:configuration.fields.map(f=>({...f,fieldName:'Renamed',sortOrder:9,isEnabled:false}))},configuration).fields.every(f=>!f.isEnabled)).toBe(true);
  });
  it('validates required only on report create/edit, retaining historical values and evidence during state changes',()=>{
    const configured={...ctx,fieldConfiguration:configuration};
    expect(()=>createQaIssue(input,'required',configured)).toThrow('qa_custom_field_required');
    const issue=createQaIssue({...input,customFields:{reason:'Repro',browser:'One'}},'valid',configured);
    const changed={...configuration,fields:configuration.fields.map(f=>f.id==='browser'?{...f,options:['Two']}:f)};
    expect(validateQaCustomFieldValues(issue.customFields,changed,issue.customFields)).toEqual(issue.customFields);
    expect(()=>validateQaCustomFieldValues({reason:'Repro',browser:'Three'},changed,issue.customFields)).toThrow('qa_invalid_custom_field_value');
    const legacy=createQaIssue(input,'legacy',ctx);
    expect(applyQaCommand(legacy,{type:'set_state',state:'failed'},configured).state).toBe('failed');
    expect(()=>applyQaCommand(legacy,{type:'edit',title:'Revised',actual:'Unexpected',steps:'',expected:'',observedEnvironment:'Stage',observedVersion:'',component:''},configured)).toThrow('qa_custom_field_required');
  });
  it('preserves disabled values without allowing new writes and rejects unknown/type-invalid values',()=>{
    const disabled={...configuration,fields:configuration.fields.map(f=>({...f,isEnabled:false}))};
    expect(validateQaCustomFieldValues({},disabled,{reason:'History'})).toEqual({reason:'History'});
    expect(()=>validateQaCustomFieldValues({reason:'Rewrite'},disabled,{reason:'History'})).toThrow('qa_custom_field_unavailable');
    expect(()=>validateQaCustomFieldValues({reason:'Good',unknown:'bad'},configuration)).toThrow('qa_custom_field_unavailable');
    expect(()=>validateQaCustomFieldValues({reason:42},configuration)).toThrow('qa_invalid_custom_field_value');
  });
  it.each([
    ['number',0,true],['number',Infinity,false],['number','1',false],['boolean',false,true],['boolean','false',false],
    ['date','2026-02-28',true],['date','2026-02-30',false],['text','x'.repeat(4001),false],['textarea','x'.repeat(20001),false],
  ])('enforces scalar type %s', (fieldType,value,valid)=>{
    const config={version:1,fields:[{id:'field',fieldName:'Field',fieldType,isEnabled:true,isRequired:true,sortOrder:0}]} as QaFieldConfiguration;
    if(valid) expect(validateQaCustomFieldValues({field:value},config).field).toBe(value);
    else expect(()=>validateQaCustomFieldValues({field:value},config)).toThrow();
  });
});
