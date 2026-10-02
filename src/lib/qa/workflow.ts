import { QA_STATES, QaError, type QaState } from './domain.ts';

export interface QaWorkflowGroup { id: QaState; label: string; states: QaState[]; }
/** Display groups never change the canonical state or its transition guards. */
export interface QaWorkflow { version: 2; order: QaState[]; labels: Record<QaState, string>; groups: QaWorkflowGroup[]; }
export const DEFAULT_QA_STATE_LABELS: Record<QaState, string> = {
  new: '新回報', triaged: '已分流', in_progress: '修復中', verification: '待部署／驗證',
  verified: '驗證通過待結案', failed: '驗證未通過', closed: '完成', dismissed: '不處理',
};
export const DEFAULT_QA_WORKFLOW: QaWorkflow = { version: 2, order: [...QA_STATES],
  labels: { new:'',triaged:'',in_progress:'',verification:'',verified:'',failed:'',closed:'',dismissed:'' }, groups: [] };
export const SLACK_QA_WORKFLOW: QaWorkflow = { ...DEFAULT_QA_WORKFLOW, order: [...QA_STATES], labels: { ...DEFAULT_QA_WORKFLOW.labels, verified:'PASS',failed:'FAIL',closed:'完成',dismissed:'不處理' },
  groups: [{ id:'triaged',label:'已分配',states:['new','triaged'] }, { id:'in_progress',label:'進行中',states:['in_progress','verification'] }] };
const OLD_STATES: QaState[] = ['new','triaged','in_progress','verification','closed'];
const fail = (): never => { throw new QaError('qa_invalid_workflow'); };
function label(value: unknown): string {
  if (typeof value !== 'string') return fail();
  const result = value.trim();
  if (result.length > 40 || /[\x00-\x1f\x7f]/.test(result)) return fail();
  return result;
}
export function validateQaWorkflow(value: unknown): QaWorkflow {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const raw = value as Record<string,unknown>;
  const legacy = raw.version === 1, states = legacy ? OLD_STATES : QA_STATES;
  if ((!legacy && raw.version !== 2) || Object.keys(raw).some(key => !(legacy ? ['version','order','labels'] : ['version','order','labels','groups']).includes(key))) return fail();
  if (!Array.isArray(raw.order) || raw.order.length !== states.length || new Set(raw.order).size !== states.length || raw.order.some(state => !states.includes(state))) return fail();
  if (!raw.labels || typeof raw.labels !== 'object' || Array.isArray(raw.labels)) return fail();
  const input = raw.labels as Record<string,unknown>;
  if (Object.keys(input).length !== states.length || Object.keys(input).some(key => !states.includes(key as QaState))) return fail();
  const labels = { ...DEFAULT_QA_WORKFLOW.labels }, used = new Set<string>();
  for (const state of states) {
    labels[state] = label(input[state]);
    if (labels[state] && used.has(labels[state].toLowerCase())) return fail();
    if (labels[state]) used.add(labels[state].toLowerCase());
  }
  const order = [...raw.order] as QaState[];
  if (legacy) {
    const at = order.indexOf('closed'); order.splice(at,0,'verified','failed'); order.splice(order.indexOf('closed')+1,0,'dismissed');
    return {version:2,order,labels,groups:[]};
  }
  if (!Array.isArray(raw.groups) || raw.groups.length > QA_STATES.length) return fail();
  const grouped = new Set<QaState>(), groupIds = new Set<QaState>();
  const groups: QaWorkflowGroup[] = raw.groups.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const group = value as Record<string,unknown>;
    if (Object.keys(group).some(key => !['id','label','states'].includes(key)) || !QA_STATES.includes(group.id as QaState)
      || groupIds.has(group.id as QaState) || !Array.isArray(group.states) || group.states.length < 2 || group.states.length > QA_STATES.length
      || !group.states.includes(group.id)) return fail();
    const groupLabel = label(group.label); if (!groupLabel) return fail();
    for (const state of group.states) { if (!QA_STATES.includes(state) || grouped.has(state)) return fail(); grouped.add(state); }
    groupIds.add(group.id as QaState);
    // PASS, FAIL and each terminal result must remain individually visible.
    if (group.states.some(state => ['verified','failed','closed','dismissed'].includes(state))) return fail();
    return {id:group.id as QaState,label:groupLabel,states:[...group.states] as QaState[]};
  });
  const result: QaWorkflow = {version:2,order,labels,groups};
  const names = getQaWorkflowColumns(result).map(column => column.label.toLowerCase());
  if (new Set(names).size !== names.length) return fail();
  return result;
}
export function parseQaWorkflow(value: unknown): QaWorkflow {
  try { return validateQaWorkflow(typeof value === 'string' ? JSON.parse(value) : value); }
  catch { return {version:2,order:[...DEFAULT_QA_WORKFLOW.order],labels:{...DEFAULT_QA_WORKFLOW.labels},groups:[]}; }
}
export function getQaStateLabel(workflow: QaWorkflow, state: QaState, fallback: (state: QaState) => string = state => DEFAULT_QA_STATE_LABELS[state]): string {
  return workflow.labels[state] || fallback(state);
}
export function getQaWorkflowColumns(workflow: QaWorkflow, fallback?: (state: QaState) => string): QaWorkflowGroup[] {
  return workflow.order.flatMap(state => {
    const group = workflow.groups.find(item => item.states.includes(state));
    return group ? group.id === state ? [{...group,states:[...group.states]}] : []
      : [{id:state,label:getQaStateLabel(workflow,state,fallback),states:[state]}];
  });
}
