// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { qaDueDateText, qaFieldChanges, qaFieldNotificationText, qaNotificationDetailText, qaNotificationReferences, qaPriorityText, qaVerificationAutoClosed } from '../lib/qa/notificationText';
import { qaNotificationMessage, type QaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-core';
import { loadQaDeliveryState } from '../../docker/volumes/functions/slack-deliver/qa-backend';
import type { Database } from '../../docker/volumes/functions/slack-interact/backend';
import type { Job } from '../../docker/volumes/functions/slack-deliver/core';
import { qaEventDetail, type QaIssue } from '../lib/qa/domain';

type Snapshot = { projectId: string; assigneeId: string | null; qaOwnerId: string | null; severity: string; priority: number; dueDate: string | null };
const before: Snapshot = { projectId: 'old-project', assigneeId: 'old-developer', qaOwnerId: 'old-qa', severity: 'high', priority: 1, dueDate: null };
const after: Snapshot = { projectId: 'new-project', assigneeId: 'new-developer', qaOwnerId: null, severity: 'low', priority: 5, dueDate: '2026-10-20' };
const detail = JSON.stringify({ before, after });
const members: Record<string, string> = { 'old-developer': 'Alex', 'new-developer': 'Blair', 'old-qa': 'Casey' };
const projects: Record<string, string> = { 'old-project': 'Atlas', 'new-project': 'Boreal' };
const ctx = { memberName: (id: string) => members[id], projectName: (id: string) => projects[id] };
const state: QaDeliveryState = {
  issue: { id: 'private-issue-identifier', projectId: 'new-project', title: 'Example bug', state: 'triaged', assigneeId: 'new-developer', qaOwnerId: null,
    severity: 'low', priority: 5, dueDate: '2026-10-20', targets: [], runs: [], fixCycle: 0 } as unknown as QaIssue,
  project: { id: 'new-project', name: 'Boreal', is_archived: false }, members: [{ id: 'new-developer', name: 'Blair' }],
  triagers: ['new-developer'], memberNames: members, projectNames: projects,
};
const job: Job = { id: 1, task_id: 'qa:private-issue-identifier', team_id: 'TEXAMPLE', target_type: 'channel', target_id: 'CEXAMPLE', attempts: 1,
  payload: { eventType: 'update_fields', actorId: 'new-developer', issueId: state.issue.id, detail } };

describe('human-readable QA notices from immutable audit snapshots', () => {
  it.each([[1, '最高'], [2, '高'], [3, '中'], [4, '低'], [5, '最低']] as const)('labels stored priority %s correctly', (priority, label) => {
    expect(qaPriorityText(priority)).toBe(label); expect(qaPriorityText(String(priority))).toBe(label);
  });
  it('uses the same priority meanings in English and simplified Chinese', () => {
    expect(qaPriorityText(1, 'en-US')).toBe('Highest'); expect(qaPriorityText(5, 'en')).toBe('Lowest'); expect(qaPriorityText(4, 'zh_CN')).toBe('低');
  });
  it.each([0, 6, 2.5, 'P4', null, {}, 'private-code'])('never prints an unknown priority code %s', value => {
    expect(qaPriorityText(value)).toBe('未設定');
  });
  it('renders all six changed fields, names, priorities and dates without raw snapshots or internal ids', () => {
    const text = qaFieldNotificationText(detail, ctx);
    expect(text.split('\n')).toEqual(['專案：Atlas → Boreal', '修復負責人：Alex → Blair', '驗證 QA：Casey → 未指定', '嚴重程度：高 → 低', '優先級：最高 → 最低', '期限：未設定 → 2026-10-20']);
    for (const id of [...Object.keys(members), ...Object.keys(projects)]) expect(text).not.toContain(id);
    expect(text).not.toContain('before'); expect(text).not.toContain('after'); expect(text).not.toContain('{');
    expect(JSON.parse(detail)).toEqual({ before, after });
  });
  it('hides severity presentation while preserving other changes and the audit snapshot', () => {
    const text = qaFieldNotificationText(detail, { ...ctx, showSeverity: false });
    expect(text.split('\n')).toEqual(['專案：Atlas → Boreal', '修復負責人：Alex → Blair', '驗證 QA：Casey → 未指定', '優先級：最高 → 最低', '期限：未設定 → 2026-10-20']);
    expect(text).not.toContain('嚴重程度');
    expect(JSON.parse(detail)).toEqual({ before, after });
    const severityOnly = JSON.stringify({ before: { severity: 'high' }, after: { severity: 'low' } });
    expect(qaFieldNotificationText(severityOnly, { ...ctx, showSeverity: false })).toBe('Bug 欄位已更新，請在 LIVO 查看詳情。');
    expect(qaFieldNotificationText(severityOnly, ctx)).toBe('嚴重程度：高 → 低');
    expect(qaNotificationDetailText('triage', 'RD: new-developer · QA: old-qa\nlow · P4\n2026-10-20', { ...ctx, showSeverity: false }))
      .toBe('修復負責人：Blair\n驗證 QA：Casey\n優先級：低\n期限：2026-10-20');
  });
  it('omits unchanged fields and supports snapshots without a before value', () => {
    expect(qaFieldNotificationText(JSON.stringify({ before, after: { ...before, priority: 4 } }), ctx)).toBe('優先級：最高 → 低');
    expect(qaFieldNotificationText(JSON.stringify({ after: { priority: 4, assigneeId: null } }), ctx)).toBe('修復負責人：未指定\n優先級：低');
  });
  it.each(['not-json private-id', JSON.stringify({ after: [] }), JSON.stringify({ before: [], after }), 'x'.repeat(16001)])('fails closed on malformed snapshots', value => {
    expect(qaFieldChanges(value)).toBeNull(); expect(qaFieldNotificationText(value, ctx)).toBe('Bug 欄位已更新，請在 LIVO 查看詳情。');
  });
  it('redacts missing, stale and invalid label ids instead of calling them unassigned', () => {
    const value = JSON.stringify({ after: { projectId: 'missing-project', assigneeId: 'missing-member', qaOwnerId: { id: 'nested-secret' }, unknownField: 'hidden-id' } });
    const text = qaFieldNotificationText(value, ctx);
    expect(text).toBe('專案：未知專案\n修復負責人：未知成員\n驗證 QA：未知成員');
    expect(text).not.toContain('missing-'); expect(text).not.toContain('nested-secret'); expect(text).not.toContain('hidden-id');
    expect(qaFieldNotificationText(JSON.stringify({ after: { assigneeId: 'same-id' } }), { ...ctx, memberName: id => id })).toContain('未知成員');
  });
  it('preserves real date-only values and redacts invalid date input', () => {
    expect(qaDueDateText('2026-10-20')).toBe('2026-10-20'); expect(qaDueDateText('2026-02-30')).toBe('未設定');
    expect(qaDueDateText('2026-10-20T00:00:00Z')).toBe('未設定'); expect(qaDueDateText('private-date-code')).toBe('未設定');
  });
  it('looks up only bounded known ids from fields that changed', () => {
    expect(qaNotificationReferences('update_fields', detail)).toEqual({ members: ['old-developer', 'new-developer', 'old-qa'], projects: ['old-project', 'new-project'] });
    expect(qaNotificationReferences('comment', detail)).toEqual({ members: [], projects: [] });
    expect(qaNotificationReferences('update_fields', JSON.stringify({ after: { assigneeId: 'x),or(id.eq.other)', projectId: 'bad,project' } }))).toEqual({ members: [], projects: [] });
  });
  it('translates existing triage audit codes and names without rewriting the snapshot', () => {
    const text = qaNotificationDetailText('triage', 'RD: new-developer · QA: old-qa\nlow · P4\n2026-10-20', ctx);
    expect(text).toContain('修復負責人：Blair'); expect(text).toContain('驗證 QA：Casey'); expect(text).toContain('優先級：低');
    expect(text).not.toContain('P4'); expect(text).not.toContain('new-developer');
    expect(qaNotificationDetailText('comment', 'Hello', ctx)).toBeUndefined();
  });
  it.each(['channel', 'member'] as const)('uses readable escaped field changes in %s Slack notices', target_type => {
    const message = qaNotificationMessage({ ...state, memberNames: { ...members, 'new-developer': 'Blair <!channel>' } }, { ...job, target_type }, 'https://example.com');
    expect(message.text).toContain('修復負責人：Alex → Blair &lt;!channel&gt;'); expect(message.text).toContain('專案：Atlas → Boreal');
    expect(message.text).toContain('優先級：最低'); expect(message.text).not.toContain('P5'); expect(message.text).not.toContain('"before"');
    const visible = message.blocks.map((block: { text?: { text: string } }) => block.text?.text || '').join('\n').replace(/<[^|]+\|([^>]+)>/g, '$1');
    expect(visible).not.toContain(state.issue.id); expect(visible).not.toContain('old-developer');
    expect(message.blocks.filter((block: { type: string }) => block.type === 'header')).toHaveLength(0);
  });
  it('keeps unresolved summary names safe even for inherited object property names', () => {
    const message = qaNotificationMessage({ ...state, issue: { ...state.issue, assigneeId: 'constructor' } }, { ...job, payload: { ...job.payload, actorId: 'toString' } }, 'https://example.com');
    expect(message.text).toContain('修復：未知成員'); expect(message.text).toContain('操作人：未知成員'); expect(message.text).not.toContain('function');
  });
  it('loads inactive member and archived project labels without changing responsible recipients', async () => {
    const rows = vi.fn(async (table: string, query: Record<string, string>) => {
      if (table === 'qa_issues') return [{ data: state.issue }];
      if (table === 'qa_project_coordination') return [{ coordinator_id: 'new-developer' }];
      if (table === 'projects') return query.id.startsWith('in.') ? [{ id: 'old-project', name: 'Atlas' }, state.project] : [state.project];
      if (table === 'members') return query.id ? [{ id: 'old-developer', name: 'Alex', role: 'super_admin', is_active: false }, { id: 'old-qa', name: 'Casey' }, { id: 'new-developer', name: 'Blair' }] : state.members;
      throw new Error('unexpected lookup');
    });
    const loaded = await loadQaDeliveryState({ rows, setting: async (): Promise<undefined> => undefined } as unknown as Database, state.issue.id, 'update_fields', detail);
    expect(loaded?.memberNames?.['old-developer']).toBe('Alex'); expect(loaded?.projectNames?.['old-project']).toBe('Atlas');
    expect(loaded?.triagers).toEqual(['new-developer']); expect(loaded?.members).toEqual(state.members);
    for (const [table, query] of rows.mock.calls) if (['members', 'projects'].includes(table) && query.id?.startsWith('in.')) {
      expect(query).toMatchObject({ select: 'id,name', limit: '10' }); expect(query).not.toHaveProperty('workspace_id'); expect(query).not.toHaveProperty('is_active');
    }
  });
});


describe('readable QA event details without exposing generated audit metadata', () => {
  const manual = '{"message":"狀態已變更","mode":"manual","from":"verification","to":"verified"}';
  const handoff = {
    handoffId: 'private-handoff-id', reason: 'Waiting for the partner response.\nKeep the error sample.',
    nextOwnerId: 'new-developer', replyBy: '2026-10-20T08:30:00.000Z', externalDependency: 'Partner test environment',
    requestedBy: 'old-developer', requestedAt: '2026-10-19T08:00:00.000Z',
    acceptedBy: 'old-qa', acceptedAt: '2026-10-19T09:00:00.000Z',
    resolvedBy: 'new-developer', resolvedAt: '2026-10-19T10:00:00.000Z', resolutionEvidence: 'Response received.\nRetest is still required.',
  };
  const value = JSON.stringify(handoff);
  const targets = [
    { id: 'private-target-one', environment: 'Staging', component: '', build: '', required: true, deployedBy: 'old-developer', deployedAt: '2026-10-20T08:30:00.000Z', deploymentEvidence: 'Release ready.\n\nCheck the logs.' },
    { id: 'private-target-two', environment: 'Production', component: 'API', build: '2.4.0', required: false, deployedBy: 'new-developer', deployedAt: '2026-10-20T09:30:00.000Z', deploymentEvidence: '{"release":"2.4.0"}' },
  ];
  const issue = { ...state.issue, state: 'verified', fixCycle: 2, fixSummary: 'Correct rounding.\n{"sample":-20.85}', targets, resolution: 'fixed', resolutionReason: 'Review complete.', duplicateOfId: null } as QaIssue;

  it.each([
    ['zh-TW', '手動變更狀態：待驗證 → PASS'],
    ['zh-CN', '手动变更状态：待验证 → PASS'],
    ['en-US', 'Manual state change：Awaiting verification → PASS'],
  ])('formats the reported manual state snapshot in %s', (locale, expected) => {
    expect(qaNotificationDetailText('set_state', manual, { ...ctx, locale })).toBe(expected);
    expect(qaNotificationDetailText('state_changed', manual, { ...ctx, locale })).toBe(expected);
    expect(JSON.parse(manual)).toEqual({ message: '狀態已變更', mode: 'manual', from: 'verification', to: 'verified' });
  });
  it('supports trusted custom labels while keeping the manual nature explicit', () => {
    expect(qaNotificationDetailText('set_state', manual, { ...ctx, stateName: state => state === 'verification' ? 'Waiting for review' : undefined }))
      .toBe('手動變更狀態：Waiting for review → PASS');
    expect(qaNotificationDetailText('set_state', manual, { ...ctx, stateName: state => state })).toBe('手動變更狀態：待驗證 → PASS');
  });
  it.each([
    '{"message":"private-id","mode":"manual","from":"verification","to":',
    '{"mode":"manual","from":"private-state-code","to":"verified"}',
    '{"mode":"manual","from":"verification","to":"constructor"}',
    '{"mode":"manual","from":null,"to":"verified"}',
    '{"mode":"automatic","from":"verification","to":"verified"}',
    'private-event-id', '[]', null, { mode: 'manual', from: 'verification', to: 'verified' },
  ])('never shows malformed or unfamiliar state metadata: %j', detail => {
    expect(qaNotificationDetailText('set_state', detail, ctx)).toBe('狀態已更新，請在 LIVO 查看詳情。');
  });
  it.each(['request_handoff', 'accept_handoff', 'resolve_handoff'])('renders %s with names and original notes', event => {
    const text = qaNotificationDetailText(event, value, ctx)!;
    expect(text).toContain(handoff.reason);
    expect(text).not.toContain('private-handoff-id');
    expect(text).not.toContain('nextOwnerId');
    for (const member of Object.keys(members)) expect(text).not.toContain(member);
    expect(JSON.parse(value)).toEqual(handoff);
  });
  it('shows precise handoff request and resolution summaries', () => {
    expect(qaNotificationDetailText('request_handoff', value, ctx)).toBe('交接給：Blair\n預期回覆時間：2026-10-20 08:30 UTC\n交接原因：Waiting for the partner response.\nKeep the error sample.\n外部依賴：Partner test environment');
    expect(qaNotificationDetailText('accept_handoff', value, ctx)).toBe('接收人：Casey\n交接原因：Waiting for the partner response.\nKeep the error sample.');
    expect(qaNotificationDetailText('resolve_handoff', value, ctx)).toBe('解除人：Blair\n解除依據：Response received.\nRetest is still required.\n交接原因：Waiting for the partner response.\nKeep the error sample.');
  });
  it.each([
    ['zh-CN', '交接给：Blair', '预期回复时间'], ['en', 'Handoff to：Blair', 'Reply by'],
  ])('localizes handoff labels in %s', (locale, heading, timeLabel) => {
    const text = qaNotificationDetailText('request_handoff', value, { ...ctx, locale });
    expect(text).toContain(heading); expect(text).toContain(timeLabel);
  });
  it('redacts stale handoff names and unsafe reference ids', () => {
    const text = qaNotificationDetailText('request_handoff', JSON.stringify({ ...handoff, nextOwnerId: 'missing-member' }), ctx);
    expect(text).toContain('交接給：未知成員'); expect(text).not.toContain('missing-member');
    expect(qaNotificationReferences('request_handoff', value)).toEqual({ members: ['new-developer', 'old-qa'], projects: [] });
    const bad = JSON.stringify({ ...handoff, nextOwnerId: 'x),or(id.eq.other)', nested: { privateId: 'old-developer' } });
    expect(qaNotificationReferences('request_handoff', bad)).toEqual({ members: [], projects: [] });
    expect(qaNotificationDetailText('request_handoff', bad, ctx)).toBe('交接紀錄已更新，請在 LIVO 查看詳情。');
  });
  it.each(['request_handoff', 'accept_handoff', 'resolve_handoff'])('fails safely for the producer-truncated 2000-character %s JSON', event => {
    const truncated = JSON.stringify({ ...handoff, reason: 'Long handoff note. '.repeat(200) }).slice(0, 2000);
    expect(qaNotificationReferences(event, truncated)).toEqual({ members: [], projects: [] });
    expect(qaNotificationDetailText(event, truncated, ctx)).toBe('交接紀錄已更新，請在 LIVO 查看詳情。');
  });
  it('does not infer acceptance or resolution from partial handoff metadata', () => {
    expect(qaNotificationDetailText('accept_handoff', JSON.stringify({ ...handoff, acceptedBy: null }), ctx)).toBe('交接紀錄已更新，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('resolve_handoff', JSON.stringify({ ...handoff, resolvedAt: 'invalid-time', resolutionEvidence: '' }), ctx)).toBe('交接紀錄已更新，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('request_handoff', JSON.stringify({ ...handoff, replyBy: '2026-02-30T08:30:00.000Z' }), ctx)).toContain('預期回覆時間：未設定');
  });
  it('labels the legacy fix summary, target environment and unfilled version', () => {
    const detail = qaEventDetail(issue, 'submit_fix');
    expect(qaNotificationDetailText('submit_fix', detail, { ...ctx, fixSnapshot: issue })).toBe('修復輪次：2\n修復說明：Correct rounding.\n{"sample":-20.85}\n\n環境：Staging\n版本：未設定\n驗證需求：必要\n\n環境：Production\n版本：2.4.0\n功能／區域：API\n驗證需求：選填');
    expect(detail).toContain('修復輪次 2');
    expect(qaNotificationDetailText('submit_fix', detail, { ...ctx, fixSnapshot: issue, locale: 'en' })).toContain('Build：Not set');
  });
  it('labels legacy dash versions as unfilled and supports trusted components containing delimiters', () => {
    const dashIssue = { ...issue, targets: [{ ...targets[0], build: '-' }] };
    expect(qaNotificationDetailText('submit_fix', qaEventDetail(dashIssue, 'submit_fix'), { ...ctx, fixSnapshot: dashIssue })).toContain('版本：未設定');
    const withDelimiter = { ...issue, targets: [{ ...targets[0], component: 'API · internal part' }] };
    expect(qaNotificationDetailText('submit_fix', qaEventDetail(withDelimiter, 'submit_fix'), { ...ctx, fixSnapshot: withDelimiter })).toContain('功能／區域：API · internal part');
  });
  it('preserves an empty fix summary without making up repair evidence', () => {
    const noSummary = { ...issue, fixSummary: '', targets: targets.slice(0, 1) };
    expect(qaNotificationDetailText('submit_fix', qaEventDetail(noSummary, 'submit_fix'), { ...ctx, fixSnapshot: noSummary })).toContain('修復說明：未設定');
  });
  it('never reclassifies a target-looking line copied in the fix summary', () => {
    const copied = 'Keep this copied example:\nExample · - · 0 · 必要';
    const current = { ...issue, fixCycle: 1, fixSummary: copied, targets: [{ ...targets[0], build: '2.4.0' }] };
    const detail = qaEventDetail(current, 'submit_fix');
    const text = qaNotificationDetailText('submit_fix', detail, { ...ctx, fixSnapshot: current })!;
    expect(text).toContain(`修復說明：${copied}`); expect(text).not.toContain('環境：Example');
    expect(text.match(/環境：/g)).toHaveLength(1);
    expect(qaEventDetail(current, 'submit_fix')).toBe(detail);
  });
  it('falls back safely when the current immutable candidate cannot identify an old fix snapshot', () => {
    const detail = qaEventDetail(issue, 'submit_fix');
    expect(qaNotificationDetailText('submit_fix', detail, ctx)).toBe('修復紀錄已更新，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('submit_fix', detail, { ...ctx, fixSnapshot: { ...issue, fixCycle: 3 } })).toBe('修復紀錄已更新，請在 LIVO 查看詳情。');
  });
  it.each([
    ['pass', 'PASS（驗證通過）'], ['fail', 'FAIL（驗證失敗）'], ['blocked', '受阻（尚未完成驗證）'],
  ] as const)('renders actual recorded %s verification distinctly from manual state changes', (result, expected) => {
    const withRun = { ...issue, runs: [{ id: 'private-run-id', sequence: 3, fixCycle: 2, targetId: targets[0].id, environment: 'Staging', component: '', build: '', result, note: '{"example":"user-authored note"}', testerId: 'old-qa', createdAt: '2026-10-20T10:00:00.000Z' }] };
    const detail = qaEventDetail(withRun, 'record_verification');
    const text = qaNotificationDetailText('record_verification', detail, ctx)!;
    expect(text).toBe(`驗證輪次：2｜驗證次數：3\n環境：Staging\n版本：未設定\n驗證結果：${expected}\n驗證備註：{"example":"user-authored note"}`);
    expect(text).not.toContain('private-run-id'); expect(text).not.toContain('old-qa'); expect(text).not.toContain('手動');
    expect(qaNotificationDetailText('record_verification', detail, { ...ctx, locale: 'en' })).toContain(result === 'blocked' ? 'Blocked (verification incomplete)' : result.toUpperCase());
    expect(qaNotificationDetailText('record_verification', detail, { ...ctx, locale: 'zh-CN' })).toContain('验证结果');
  });
  it('replaces deployment member metadata with names without altering evidence paragraphs', () => {
    const detail = qaEventDetail(issue, 'record_deployment');
    const text = qaNotificationDetailText('record_deployment', detail, { ...ctx, fixSnapshot: issue })!;
    expect(text).toBe('環境：Staging\n版本：未設定\n驗證需求：必要\n部署人：Alex\n部署時間：2026-10-20 08:30 UTC\n部署依據：Release ready.\n\nCheck the logs.\n\n環境：Production\n版本：2.4.0\n功能／區域：API\n驗證需求：選填\n部署人：Blair\n部署時間：2026-10-20 09:30 UTC\n部署依據：{"release":"2.4.0"}');
    expect(qaNotificationReferences('record_deployment', detail)).toEqual({ members: [], projects: [] });
    expect(text).not.toContain('old-developer'); expect(text).not.toContain('private-target');
  });
  it('never infers label queries from deployment evidence or user note JSON', () => {
    const many = { ...issue, targets: Array.from({ length: 30 }, (_, index) => ({ ...targets[0], deployedBy: `example-member-${index}` })) };
    const refs = qaNotificationReferences('record_deployment', qaEventDetail(many, 'record_deployment'));
    expect(refs).toEqual({ members: [], projects: [] });
    expect(qaNotificationReferences('comment', value)).toEqual({ members: [], projects: [] });
  });
  it('preserves a deployment-looking log excerpt as author evidence', () => {
    const copied = 'Compare this pasted sample:\n\nProduction · - · 9.9 · 必要\n2026-10-20T10:00:00.000Z · example-member\nThis is a log excerpt.';
    const current = { ...issue, targets: [{ ...targets[0], build: '2.4.0', deploymentEvidence: copied }] };
    const detail = qaEventDetail(current, 'record_deployment');
    const text = qaNotificationDetailText('record_deployment', detail, { ...ctx, fixSnapshot: current })!;
    expect(text).toContain(`部署依據：${copied}`); expect(text).not.toContain('環境：Production');
    expect(text.match(/部署人：/g)).toHaveLength(1);
    expect(qaNotificationReferences('record_deployment', detail)).toEqual({ members: [], projects: [] });
    expect(qaEventDetail(current, 'record_deployment')).toBe(detail);
  });
  it('uses complete trusted evidence when a copied example repeats generated deployment metadata', () => {
    const signature = 'Production · API · 2.4.0 · 選填\n2026-10-20T09:30:00.000Z · new-developer\n';
    const evidence = 'Example:\n\n' + signature + 'Copied content.';
    const current = { ...issue, targets: [{ ...targets[0], deploymentEvidence: evidence }, targets[1]] };
    const text = qaNotificationDetailText('record_deployment', qaEventDetail(current, 'record_deployment'), { ...ctx, fixSnapshot: current })!;
    expect(text).toContain(`部署依據：${evidence}`); expect(text.match(/環境：Production/g)).toHaveLength(1);
    expect(text).toContain('部署依據：{"release":"2.4.0"}');
    expect(qaNotificationDetailText('record_deployment', qaEventDetail(issue, 'record_deployment'), ctx)).toBe('部署紀錄已更新，請在 LIVO 查看詳情。');
  });
  it('safely summarizes a 2,000-character deployment payload ending inside a copied real target signature', () => {
    const signature = 'Production · - · 2.4.0 · 必要\n2026-10-20T08:00:00.000Z · new-developer\n';
    const evidence = 'Copied excerpt:\n\n' + signature + 'Example only, not Production evidence.\n' + 'x'.repeat(2200);
    const current = { ...issue, targets: [
      { ...targets[0], build: '2.4.0', deployedAt: '2026-10-20T09:00:00.000Z', deploymentEvidence: evidence },
      { ...targets[1], component: '', required: true, deployedAt: '2026-10-20T08:00:00.000Z', deploymentEvidence: 'The real Production evidence.' },
    ] };
    const full = qaEventDetail(current, 'record_deployment'); expect(full.length).toBeGreaterThan(2000);
    expect(qaNotificationDetailText('record_deployment', full.slice(0, 2000), { ...ctx, fixSnapshot: current })).toBe('部署紀錄已更新，請在 LIVO 查看詳情。');
    const text = qaNotificationDetailText('record_deployment', full, { ...ctx, fixSnapshot: current })!;
    expect(text).toContain(`部署依據：${evidence}`); expect(text).toContain('部署依據：The real Production evidence.');
    expect(text.match(/環境：Production/g)).toHaveLength(1);
    expect(qaNotificationReferences('record_deployment', full.slice(0, 2000))).toEqual({ members: [], projects: [] });
    const stale = { ...current, targets: current.targets.map(target => ({ ...target, deploymentEvidence: target.deploymentEvidence + ' Later note.' })) };
    expect(qaNotificationDetailText('record_deployment', full, { ...ctx, fixSnapshot: stale })).toBe('部署紀錄已更新，請在 LIVO 查看詳情。');
  });
  it('requires the complete trusted fix summary when truncation ends at a copied target suffix', () => {
    const target = { ...targets[0], build: '2.4.0' }, prefix = '修復輪次 2\n', suffix = '\nStaging · - · 2.4.0 · 必要', header = 'Copied example:\n';
    const summary = header + 'x'.repeat(2000 - prefix.length - suffix.length - header.length) + suffix + '\nThe actual summary continues.';
    const current = { ...issue, fixSummary: summary, targets: [target] }, full = qaEventDetail(current, 'submit_fix');
    expect(full.slice(0, 2000)).toMatch(/Staging · - · 2\.4\.0 · 必要$/);
    expect(qaNotificationDetailText('submit_fix', full.slice(0, 2000), { ...ctx, fixSnapshot: current })).toBe('修復紀錄已更新，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('submit_fix', full, { ...ctx, fixSnapshot: current })).toContain(`修復說明：${summary}`);
    expect(qaNotificationDetailText('submit_fix', full, { ...ctx, fixSnapshot: { fixCycle: current.fixCycle, targets: current.targets } })).toBe('修復紀錄已更新，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('submit_fix', full, { ...ctx, fixSnapshot: { ...current, fixSummary: 'A later summary.' } })).toBe('修復紀錄已更新，請在 LIVO 查看詳情。');
  });
  it.each([
    ['fixed', '已修復'], ['duplicate', '重複 Bug'], ['not_bug', '非 Bug'], ['wont_fix', '不處理'], ['cannot_reproduce', '無法重現'],
  ] as const)('translates %s closing metadata and preserves the reason', (resolution, label) => {
    const detail = qaEventDetail({ ...issue, resolution, duplicateOfId: resolution === 'duplicate' ? 'private-other-issue-id' : null }, 'close');
    const text = qaNotificationDetailText('close', detail, ctx)!;
    expect(text).toBe(`結案結果：${label}\n結案說明：Review complete.`);
    expect(text).not.toContain('private-other-issue-id');
  });
  it('shows linked-task counts without task record ids', () => {
    expect(qaNotificationDetailText('link_tasks', 'private-task-one\nprivate-task-two', ctx)).toBe('已連結任務：2');
    expect(qaNotificationDetailText('link_tasks', '', ctx)).toBe('已更新連結任務，請在 LIVO 查看詳情。');
    expect(qaNotificationDetailText('link_tasks', Array.from({ length: 51 }, (_, n) => `private-task-${n}`).join('\n'), ctx)).toBe('已更新連結任務，請在 LIVO 查看詳情。');
  });
  it.each(['submit_fix', 'record_deployment', 'record_verification', 'close', 'link_tasks', 'future_action'])('never passes raw unfamiliar structured metadata for %s', event => {
    const detail = '{"internalRecordId":"private-record-id","body":{"code":"internal-code"}}';
    const text = qaNotificationDetailText(event, detail, ctx)!;
    expect(text).toContain('LIVO'); expect(text).not.toContain('{'); expect(text).not.toContain('private-record-id'); expect(text).not.toContain('internal-code');
  });
  it.each(['comment', 'hold', 'reopen'])('keeps human-authored %s notes intact even if they contain structured-looking examples', event => {
    for (const note of ['{"message":"status example","mode":"manual","from":"verification","to":"verified"}', '{incomplete JSON example', 'Line one\n\n<!channel> & code']) {
      expect(qaNotificationDetailText(event, note, ctx)).toBeUndefined();
    }
  });
  it.each(['channel', 'member'] as const)('uses safe, escaped manual event text in %s notices after shared code synchronization', target_type => {
    const message = qaNotificationMessage(state, { ...job, target_type, payload: { ...job.payload, eventType: 'set_state', detail: manual } }, 'https://example.com');
    expect(message.text).toContain('手動變更狀態：待驗證 → PASS');
    expect(message.text).not.toContain('"mode"'); expect(message.text).not.toContain('"from"'); expect(message.text).not.toContain('"to"');
    const handoffMessage = qaNotificationMessage({ ...state, memberNames: { ...members, 'new-developer': 'Blair <!channel>' } }, { ...job, target_type, payload: { ...job.payload, eventType: 'request_handoff', detail: value } }, 'https://example.com');
    expect(handoffMessage.text).toContain('交接給：Blair &lt;!channel&gt;'); expect(handoffMessage.text).not.toContain('private-handoff-id');
  });
});


describe('verified automatic-closure notification metadata', () => {
  const marker = '所有必要環境已部署並驗證通過，已自動結案。';
  const candidate = (note = ''): QaIssue => ({ ...state.issue, state: 'closed', resolution: 'fixed', fixCycle: 1,
    closedAt: '2026-10-20T08:30:00.000Z', closedBy: 'new-developer',
    targets: [{ id: 'target-example', environment: 'Staging', component: '', build: '2.4.0', required: true, deployedAt: '2026-10-20T08:00:00.000Z', deployedBy: 'new-developer', deploymentEvidence: '' }],
    runs: [{ id: 'run-example', sequence: 1, fixCycle: 1, targetId: 'target-example', environment: 'Staging', component: '', build: '2.4.0', result: 'pass', note, testerId: 'new-developer', createdAt: '2026-10-20T08:30:00.000Z' }],
  });
  it.each([
    ['zh-TW', marker], ['zh-CN', '所有必要环境已部署并验证通过，已自动结案。'],
    ['en', 'All required environments were deployed and passed verification. The bug closed automatically.'],
  ])('renders actual final PASS closure separately from the verification note in %s', (locale, label) => {
    const issue = candidate(), detail = qaEventDetail(issue, 'record_verification');
    expect(qaVerificationAutoClosed(detail, issue)).toBe(true);
    const text = qaNotificationDetailText('record_verification', detail, { ...ctx, locale, verificationSnapshot: issue });
    expect(text).toContain(label); expect(text).not.toMatch(/(?:驗證備註|验证备注|Verification note)：/);
  });
  it('preserves an author-copied marker as a note and recognizes only the separate generated closure line', () => {
    const issue = candidate('{"sample":"PASS"}\n' + marker), detail = qaEventDetail(issue, 'record_verification');
    const text = qaNotificationDetailText('record_verification', detail, { ...ctx, verificationSnapshot: issue })!;
    expect(text).toContain('驗證備註：{"sample":"PASS"}\n' + marker);
    expect(text.match(new RegExp(marker, 'g'))).toHaveLength(2);
    const manual: QaIssue = { ...issue, state: 'verified', resolution: null, closedAt: null, closedBy: null };
    expect(qaVerificationAutoClosed(qaEventDetail(manual, 'record_verification'), manual)).toBe(false);
    expect(qaVerificationAutoClosed(detail.slice(0, -1), issue)).toBe(false);
  });
  it.each(['undeployed', 'failed', 'previous-cycle', 'wrong-actor', 'wrong-time', 'missing-snapshot'])('does not infer automatic closure from a marker with %s evidence', mode => {
    const issue = candidate(), detail = qaEventDetail(issue, 'record_verification');
    if (mode === 'undeployed') issue.targets[0].deployedAt = null;
    if (mode === 'failed') issue.runs[0].result = 'fail';
    if (mode === 'previous-cycle') issue.runs[0].fixCycle = 0;
    if (mode === 'wrong-actor') issue.closedBy = 'old-developer';
    if (mode === 'wrong-time') issue.closedAt = '2026-10-20T09:00:00.000Z';
    expect(qaVerificationAutoClosed(detail, mode === 'missing-snapshot' ? undefined : issue)).toBe(false);
  });
  it('publishes one readable closed notification with no repeated close action', () => {
    const issue = candidate(), detail = qaEventDetail(issue, 'record_verification');
    const result = qaNotificationMessage({ ...state, issue }, { ...job, payload: { ...job.payload, eventType: 'record_verification', detail } }, 'https://example.com');
    expect(result.text).toContain(marker);
    expect(result.text).toContain('已結案');
    expect(result.text).not.toContain('驗證備註：');
    const buttons = JSON.stringify(result.blocks.filter((block: { type: string }) => block.type === 'actions'));
    expect(buttons).not.toContain('livo_qa_close'); expect(buttons).not.toContain('livo_qa_pass');
  });
});
