import {describe,it,expect} from 'vitest';
import {defaultDeploymentQueueSettings,isDeploymentQueueOperator,parseDeploymentQueueSettings} from '../lib/deploymentQueue';
describe('shared deployment queue configuration',()=>{
 const config={version:1,enabled:true,taskStatusIds:['example-status'],operatorMemberIds:['example-operator']};
 it('starts disabled without appointed operators',()=>{expect(defaultDeploymentQueueSettings()).toEqual({version:1,enabled:false,taskStatusIds:[],operatorMemberIds:[]});expect(isDeploymentQueueOperator(undefined,{deploymentQueue:true},'example-operator')).toBe(false);});
 it('requires both gates and the current member appointment',()=>{
  expect(isDeploymentQueueOperator(config,{deploymentQueue:true},'example-operator')).toBe(true);
  for(const [value,flags,id] of [[{...config,enabled:false},{deploymentQueue:true},'example-operator'],[config,{deploymentQueue:false},'example-operator'],[config,{deploymentQueue:true},'example-other']])expect(isDeploymentQueueOperator(value,flags,id as string)).toBe(false);
 });
 it('rejects malformed, duplicate, unrecognized and over-limit values',()=>{
  for(const value of [null,[],{}, {...config,version:2},{...config,enabled:1},{...config,operatorMemberIds:['example-operator','example-operator']},{...config,taskStatusIds:['bad slash']},{...config,operatorMemberIds:[false]},{...config,operatorMemberIds:Array.from({length:201},(_,i)=>'example-'+i)},{...config,extra:true}])expect(parseDeploymentQueueSettings(value)).toBeNull();
 });
 it('parses saved JSON and returns independent arrays',()=>{const parsed=parseDeploymentQueueSettings(JSON.stringify(config));expect(parsed).toEqual(config);parsed!.operatorMemberIds.push('example-another');expect(config.operatorMemberIds).toEqual(['example-operator']);});
});
