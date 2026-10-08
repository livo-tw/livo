import { describe, expect, it } from 'vitest';
import { qaEventText } from '../components/qa/qaEventText';
import type { QaDisplaySettings } from '../lib/qa/displaySettings';
import { qaNotificationMessage, type QaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-core.ts';
import { qaSlackCard, qaSlackTargetSummary } from '../lib/qa/slack.ts';
import type { QaIssue, QaRun, QaTarget } from '../lib/qa/domain.ts';
import type { Job } from '../../docker/volumes/functions/slack-deliver/core.ts';

const target: QaTarget = { id: 'target-example', environment: 'Staging', component: '', build: '2.0.0', required: true,
  deployedAt: null, deployedBy: null, deploymentEvidence: '' };
const issue = { id: 'issue-example', projectId: 'project-example', title: 'Example calculation discrepancy',
  state: 'new', assigneeId: 'alex', qaOwnerId: 'blair', severity: 'high', priority: 2, dueDate: null, fixCycle: 1,
  observedEnvironment: 'Staging', observedVersion: '2.0.0', actual: 'Actual value is 18', expected: 'Expected value is 20',
  steps: 'Open the example report', targets: [target], runs: [] } as unknown as QaIssue;
const state: QaDeliveryState = { issue, project: { id: 'project-example', name: 'Atlas' }, triagers: [],
  members: [{ id: 'alex', name: 'Alex' }, { id: 'blair', name: 'Blair' }] };
function message(type = 'created', detail = 'legacy flattened text', override: Partial<QaIssue> = {}) {
  const job: Job = { id: 1, task_id: 'qa:issue-example', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
    payload: { eventType: type, actorId: 'alex', issueId: issue.id, detail } };
  return qaNotificationMessage({ ...state, issue: { ...issue, ...override } }, job, 'https://example.com');
}
function blockText(value: ReturnType<typeof message>): string {
  return value.blocks.filter((block: { text?: unknown }) => block.text).map((block: { text: { text: string } }) => block.text.text).join('\n');
}
describe('QA notification report readability', () => {
  it.each(['create', 'created', 'edit'])('labels current report fields for %s without repeating the title or metadata', type => {
    const result = message(type), text = blockText(result);
    expect(text).toContain('回報內容（目前卡片）');
    expect(text).toContain('環境：Staging｜發現版本：2.0.0');
    expect(text).toContain('*實際結果*\nActual value is 18');
    expect(text).toContain('*預期結果*\nExpected value is 20');
    expect(text).toContain('*重現步驟／備註*\nOpen the example report');
    expect(text.match(/Example calculation discrepancy/g)).toHaveLength(1);
    expect(text.match(/優先級：/g)).toHaveLength(1);
    expect(text.match(/嚴重度：/g)).toHaveLength(1);
    expect(text.match(/修復輪次：/g)).toHaveLength(1);
    expect(text).not.toContain('legacy flattened text');
    expect(text).not.toMatch(/\bP[1-5]\b/);
  });
  it('keeps empty optional fields out while labeling unknown environment/version', () => {
    const text = blockText(message('created', '', { observedEnvironment: '', observedVersion: '', expected: '', steps: '' }));
    expect(text).toContain('環境：未設定｜發現版本：未填寫');
    expect(text).not.toContain('*預期結果*'); expect(text).not.toContain('*重現步驟／備註*');
  });
  it('escapes user text and bounds every report section independently', () => {
    const result = message('created', '', { actual: '<!channel>&'.repeat(1000), expected: '<@UFAKE>', steps: 'example' });
    expect(result.text).toContain('&lt;@UFAKE&gt;'); expect(result.text).not.toContain('<!channel>');
    for (const block of result.blocks) if (block.type === 'section') expect(block.text.text.length).toBeLessThanOrEqual(3000);
    expect(result.text).toContain('*预期結果*'.replace('预', '預')); expect(result.text).toContain('*重現步驟／備註*');
  });
  it('renders manual state changes and keeps the formal current evidence independent', () => {
    const text = blockText(message('set_state', JSON.stringify({ message: '狀態已變更', mode: 'manual', from: 'verification', to: 'verified' }), { state: 'verified' }));
    expect(text).toContain('手動變更狀態：待驗證 → PASS'); expect(text).not.toContain('"mode"'); expect(text).not.toContain('"from"');
    expect(text).toContain('部署：待部署｜驗證：尚未驗證');
  });
  it('preserves escaped human JSON examples in comments', () => {
    const text = blockText(message('comment', '{"sample":"<@UFAKE>"}'));
    expect(text).toContain('{"sample":"&lt;@UFAKE&gt;"}');
  });
  it('hides severity in summaries and field-change notices according to instance settings', () => {
    const displaySettings: QaDisplaySettings = { version: 1, showSeverity: false, hiddenPriorityChoices: [1, 5], hiddenBoardStates: [] };
    const job: Job = { id: 1, task_id: 'qa:issue-example', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
      payload: { eventType: 'update_fields', actorId: 'alex', issueId: issue.id, detail: JSON.stringify({ before: { severity: 'high', priority: 3 }, after: { severity: 'low', priority: 2 } }) } };
    const result = qaNotificationMessage({ ...state, displaySettings }, job, 'https://example.com');
    expect(blockText(result)).not.toContain('嚴重度'); expect(blockText(result)).toContain('優先級：中 → 高');
    expect(JSON.stringify(qaSlackCard(issue, 'https://example.com', undefined, displaySettings))).not.toContain('嚴重度');
  });
  it('preserves the same permission-checked action identifiers', () => {
    const result = message('created');
    const actions = result.blocks.filter((block: { type: string }) => block.type === 'actions').flatMap((block: { elements: unknown[] }) => block.elements);
    expect(actions.map((action: { action_id?: string }) => action.action_id).filter(Boolean)).toEqual(['livo_qa_fix', 'livo_qa_comment', 'livo_qa_new']);
    expect(actions.find((action: { url?: string }) => action.url)?.url).toBe('https://example.com/?qa=issue-example');
  });
});
describe('labeled deployment evidence on shared QA Slack cards', () => {
  it('does not treat a manually selected PASS or an old-cycle run as formal verification', () => {
    const old = { fixCycle: 0, targetId: target.id, sequence: 1, result: 'pass' } as QaRun;
    expect(qaSlackTargetSummary({ ...issue, state: 'verified', runs: [old], targets: [{ ...target, deployedAt: '2026-10-08T00:00:00Z' }] })).toContain('部署：已部署｜驗證：待驗證');
  });
  it.each([['pass', 'PASS'], ['fail', 'FAIL'], ['blocked', '卡關']] as const)('uses the latest current-cycle %s result', (result, label) => {
    const run = { fixCycle: 1, targetId: target.id, sequence: 2, result } as QaRun;
    const value = { ...issue, runs: [run], targets: [{ ...target, deployedAt: '2026-10-08T00:00:00Z' }] };
    expect(qaSlackTargetSummary(value)).toContain(`部署：已部署｜驗證：${label}`);
    expect(JSON.stringify(qaSlackCard(value, 'https://example.com'))).toContain('環境：Staging｜版本：2.0.0');
  });
});

describe('readable preserved event history', () => {
  const ctx = { t: ((key: string) => key) as never, member: (id: string) => id, task: (id: string) => id, stateLabel: (id: string) => id, date: (value: string) => value };
  it('does not expose truncated machine JSON in state or handoff history', () => {
    expect(qaEventText({ type: 'set_state', detail: '{"mode":"manual","from":' }, ctx)).toBe('qa.historyEvent.set_state');
    expect(qaEventText({ type: 'request_handoff', detail: '{"nextOwnerId":"private' }, ctx)).toBe('qa.historyEvent.request_handoff');
  });
  it('hides only the configured severity change in history without editing the snapshot', () => {
    const event = { type: 'update_fields', detail: JSON.stringify({ before: { severity: 'high' }, after: { severity: 'low' } }) };
    const original = event.detail;
    expect(qaEventText(event, { ...ctx, showSeverity: false })).toBe('qa.historyEvent.update_fields');
    expect(event.detail).toBe(original);
  });
});
