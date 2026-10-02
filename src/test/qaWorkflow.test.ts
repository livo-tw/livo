import { describe, expect, it } from 'vitest';
import { DEFAULT_QA_WORKFLOW, parseQaWorkflow, validateQaWorkflow } from '../lib/qa/workflow';
import { qaSlackCard } from '../lib/qa/slack';
import { canQaCommand, type QaIssue } from '../lib/qa/domain';
describe('Shared company QA display workflow',()=>{
  it('supports a new column order and custom label while preserving machine state IDs',()=>{
    const workflow=validateQaWorkflow({...DEFAULT_QA_WORKFLOW,order:[...DEFAULT_QA_WORKFLOW.order].reverse(),labels:{...DEFAULT_QA_WORKFLOW.labels,verification:'QA 複驗'}});
    expect(workflow.order[0]).toBe('closed');expect(workflow.labels.verification).toBe('QA 複驗');
    const issue={id:'one',title:'Bug',state:'verification',severity:'high',fixCycle:1,targets:[],runs:[],qaOwnerId:'qa',assigneeId:'rd'} as unknown as QaIssue;
    expect(JSON.stringify(qaSlackCard(issue,'https://example.com',workflow))).toContain('QA 複驗');
    expect(canQaCommand(issue,{id:'rd',role:'member'},'record_verification')).toBe(false);
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
