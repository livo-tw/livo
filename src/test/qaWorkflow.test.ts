import { describe, expect, it } from 'vitest';
import { DEFAULT_QA_WORKFLOW, getQaWorkflowColumns, getQaStateLabel, parseQaWorkflow, validateQaWorkflow } from '../lib/qa/workflow';
import { qaSlackCard } from '../lib/qa/slack';
import { canQaCommand, type QaIssue } from '../lib/qa/domain';
describe('Shared company QA display workflow',()=>{
  it('supports a new column order and custom label while preserving machine state IDs',()=>{
    const workflow=validateQaWorkflow({...DEFAULT_QA_WORKFLOW,order:[...DEFAULT_QA_WORKFLOW.order].reverse(),labels:{...DEFAULT_QA_WORKFLOW.labels,verification:'QA 複驗'}});
    expect(workflow.order[0]).toBe('dismissed');expect(workflow.labels.verification).toBe('QA 複驗');
    const issue={id:'one',title:'Bug',state:'verification',severity:'high',fixCycle:1,targets:[],runs:[],qaOwnerId:'qa',assigneeId:'rd'} as unknown as QaIssue;
    expect(JSON.stringify(qaSlackCard(issue,'https://example.com',workflow))).toContain('QA 複驗');
    expect(canQaCommand(issue,{id:'rd',role:'member'},'record_verification')).toBe(false);
  });
  it('upgrades saved v1 names/order without merging verification with closure',()=>{
    const old={version:1,order:['closed','verification','in_progress','triaged','new'],labels:{new:'New reports',triaged:'Assigned',in_progress:'Working',verification:'Testing',closed:'Done'}};
    const upgraded=parseQaWorkflow(old);
    expect(upgraded.version).toBe(2);expect(upgraded.labels.verification).toBe('Testing');expect(upgraded.order).toEqual(['verified','failed','closed','dismissed','verification','in_progress','triaged','new']);
    expect(upgraded.groups).toEqual([]);
  });
  it('preserves saved custom groups without hiding distinct canonical stages or outcomes',()=>{
    const custom={...DEFAULT_QA_WORKFLOW,groups:[{id:'triaged',label:'Assigned',states:['new','triaged']},{id:'in_progress',label:'Working',states:['in_progress','verification']}],labels:{...DEFAULT_QA_WORKFLOW.labels,verified:'Passed',failed:'Failed',closed:'Done',dismissed:'Dismissed'}};
    const workflow=validateQaWorkflow(custom),columns=getQaWorkflowColumns(workflow);
    expect(columns).toHaveLength(6);expect(columns.map(c=>c.label)).toEqual(['Assigned','Working','Passed','Failed','Done','Dismissed']);
    expect(columns[0].states).toEqual(['new','triaged']);expect(columns[1].states).toEqual(['in_progress','verification']);
    expect(getQaStateLabel(workflow,'new')).toBe('新回報');expect(getQaStateLabel(workflow,'verification')).toBe('待部署／驗證');
    for(const states of [['verified','closed'],['failed','in_progress'],['closed','dismissed']])
      expect(()=>validateQaWorkflow({...workflow,groups:[{id:states[0],label:'Hidden distinction',states}]})).toThrow('qa_invalid_workflow');
  });
  it('rejects duplicate group membership and unknown state IDs',()=>{
    expect(()=>validateQaWorkflow({...DEFAULT_QA_WORKFLOW,groups:[{id:'new',label:'A',states:['new','triaged']},{id:'triaged',label:'B',states:['triaged','in_progress']}]})).toThrow('qa_invalid_workflow');
  });
  it('cannot add, remove, duplicate or rename the machine states',()=>{
    for(const order of [[],['new'],['new','new','in_progress','verification','closed'],['new','triaged','in_progress','custom','closed']])
      expect(()=>validateQaWorkflow({...DEFAULT_QA_WORKFLOW,order})).toThrow('qa_invalid_workflow');
    expect(()=>validateQaWorkflow({...DEFAULT_QA_WORKFLOW,transitions:{new:'closed'}})).toThrow('qa_invalid_workflow');
  });
  it('validates labels and defaults safely for missing or old settings',()=>{
    expect(parseQaWorkflow(undefined)).toEqual(DEFAULT_QA_WORKFLOW);expect(parseQaWorkflow('{broken')).toEqual(DEFAULT_QA_WORKFLOW);
    for(const label of ['x'.repeat(41),'x\nline']) expect(()=>validateQaWorkflow({...DEFAULT_QA_WORKFLOW,labels:{...DEFAULT_QA_WORKFLOW.labels,new:label}})).toThrow('qa_invalid_workflow');
    expect(()=>validateQaWorkflow({...DEFAULT_QA_WORKFLOW,labels:{...DEFAULT_QA_WORKFLOW.labels,new:'Same',closed:'same'}})).toThrow('qa_invalid_workflow');
  });
});
