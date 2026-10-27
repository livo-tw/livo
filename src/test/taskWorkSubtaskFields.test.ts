import { describe, expect, it } from 'vitest';
import { canonicalTaskWorkPayload, parseTaskWorkCommand } from '@/lib/taskWork/core';
import type { TaskWorkCommand } from '@/lib/taskWork/core';

const base: Extract<TaskWorkCommand, { operation: 'create_subtask' }> = { commandId: 'command-example', taskId: 'parent', operation: 'create_subtask' as const,
  title: 'Child', statusId: 'open', priority: 'medium', assigneeId: null, reviewerId: null, dueDate: null };

describe('subtask creation carries the data its required-field form collected', () => {
  it('transports the child own requirement fields and required custom values through the atomic command', () => {
    const details = { background: '<p>Child background</p>', requirement: '<p>Child requirement</p>',
      customFields: [{ fieldId: 'field-example', valueText: 'Child custom value' }] };
    expect(parseTaskWorkCommand({ ...base, details })).toMatchObject({ operation: 'create_subtask', details });
  });

  it('preserves existing title-only command receipt bytes when no supplemental fields were sent', () => {
    expect(canonicalTaskWorkPayload(base)).toBe('{"assigneeId":null,"commandId":"command-example","dueDate":null,"operation":"create_subtask","priority":"medium","reviewerId":null,"statusId":"open","taskId":"parent","title":"Child"}');
  });
});

describe('supplemental subtask data rejects malformed or unbounded commands before either backend', () => {
  it.each([
    {workspaceId:'other'}, {startDate:'2026-02-30'}, {tagIds:['tag-example','tag-example']},
    {customFields:[{fieldId:'field-example',valueNumber:Infinity}]}, {customFields:[{fieldId:'field-example',valueBoolean:'false'}]},
    {customFields:[{fieldId:'field-example',memberId:'another-member'}]},
    {deployments:[{environment:'test',status:'unknown'}]}, {checks:Array.from({length:101},()=> 'Check')},
  ])('rejects invalid details %#', details => { expect(()=>parseTaskWorkCommand({...base,details})).toThrow('work_invalid_input'); });
  it('accepts rich text larger than the old tiny request limit while preserving explicit false and zero', () => {
    const details={background:'x'.repeat(40000),customFields:[{fieldId:'field-number',valueNumber:0},{fieldId:'field-bool',valueBoolean:false}]};
    expect(parseTaskWorkCommand({...base,details})).toMatchObject({details});
  });
  it('bounds the total encoded body, including multibyte custom text', () => {
    const details={customFields:Array.from({length:30},(_,index)=>({fieldId:`field-${index}`,valueText:'😀'.repeat(10000)}))};
    expect(()=>parseTaskWorkCommand({...base,details})).toThrow('work_invalid_input');
  });
});
