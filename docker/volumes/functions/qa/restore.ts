import { QaError, validateQaHandoff, QA_MAX_FILE_BYTES, QA_STATES, type QaIssue } from './domain.ts';

const bad = (): never => { throw new QaError('qa_invalid_backup'); };
const record = (v: unknown): Record<string, any> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : bad();
const str = (v: unknown, max: number, required = false) => typeof v === 'string' && v.length <= max && !v.includes('\0') && (!required || !!v.trim()) || bad();
const id = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v) || bad();
const integer = (v: unknown, min: number, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(v) && Number(v) >= min && Number(v) <= max || bad();
const date = (v: unknown, nullable = false) => (nullable && v === null) || (typeof v === 'string' && Number.isFinite(Date.parse(v))) || bad();

/** Validate untrusted JSON before SQL preflight and before any ordinary restore.
 * SQL independently checks row types, references, tenant and version conflicts. */
export function validateQaBackup(input: unknown): Record<string, any> {
  const tables = record(input);
  for (const table of ['qa_issues', 'qa_commands', 'qa_events', 'qa_comments', 'qa_uploads', 'qa_attachments', 'qa_slack_links']) {
    if (!Array.isArray(tables[table]) || tables[table].length > 100000) bad();
    const ids = new Set<string>();
    for (const value of tables[table]) {
      const row = record(value);
      if (row.workspace_id !== 'default' || typeof row.id !== 'string' || ids.has(row.id)) bad();
      ids.add(row.id);
      if (table !== 'qa_commands') id(row.id);
      if (table === 'qa_issues') {
        const issue = record(row.data) as QaIssue;
        validateQaHandoff(issue.handoff);
        id(issue.id); id(issue.projectId); id(issue.reporterId);
        if (issue.assigneeId !== null) id(issue.assigneeId);
        if (issue.qaOwnerId !== null) id(issue.qaOwnerId);
        if (issue.id !== row.id || issue.workspaceId !== 'default' || issue.projectId !== row.project_id ||
          issue.reporterId !== row.reporter_id || issue.assigneeId !== row.assignee_id || issue.qaOwnerId !== row.qa_owner_id ||
          issue.title !== row.title || issue.version !== row.version || issue.state !== row.state ||
          Date.parse(issue.updatedAt) !== Date.parse(row.updated_at) || !QA_STATES.includes(issue.state)) bad();
        str(issue.title, 200, true); str(issue.actual, 20000, true); str(issue.observedEnvironment, 120, true);
        for (const key of ['steps', 'expected'] as const) str(issue[key], 20000);
        str(issue.observedVersion, 200); str(issue.component, 120); str(issue.fixSummary, 8000);
        str(issue.holdReason, 8000); str(issue.resolutionReason, 8000);
        if (issue.reopenReason !== undefined) str(issue.reopenReason, 8000);
        if (!['untriaged', 'low', 'medium', 'high'].includes(issue.severity)) bad();
        integer(issue.priority, 1, 5); integer(issue.version, 1); integer(issue.fixCycle, 0);
        date(issue.createdAt); date(issue.updatedAt); date(issue.closedAt, true); date(issue.reopenedAt, true);
        if (issue.dueDate !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(issue.dueDate) || !Number.isFinite(Date.parse(issue.dueDate)))) bad();
        if (issue.resolution !== null && !['fixed', 'duplicate', 'not_bug', 'wont_fix', 'cannot_reproduce'].includes(issue.resolution)) bad();
        const terminal = issue.state === 'closed' || issue.state === 'dismissed';
        if (terminal ? !issue.closedAt : issue.resolution !== null || issue.closedAt !== null) bad();
        if (issue.closedBy != null) id(issue.closedBy);
        if (issue.customFields !== undefined) {
          const fields = record(issue.customFields);
          if (Object.keys(fields).length > 100 || new TextEncoder().encode(JSON.stringify(fields)).byteLength > 100000) bad();
          for (const value of Object.values(fields)) if (value !== null && (typeof value === 'number' ? !Number.isFinite(value) : !['string','boolean'].includes(typeof value))) bad();
        }
        if (issue.duplicateOfId !== null) { id(issue.duplicateOfId); if (issue.duplicateOfId === issue.id || issue.resolution !== 'duplicate') bad(); }
        if (!Array.isArray(issue.targets) || issue.targets.length > 30 || !Array.isArray(issue.runs) || issue.runs.length > 2000 ||
          !Array.isArray(issue.taskIds) || issue.taskIds.length > 50 || new Set(issue.taskIds).size !== issue.taskIds.length) bad();
        issue.taskIds.forEach(id);
        const targets = new Set<string>(), runIds = new Set<string>(), sequences = new Set<number>();
        for (const raw of issue.targets) {
          const target = record(raw); id(target.id); if (targets.has(target.id)) bad(); targets.add(target.id);
          str(target.environment, 120, true); str(target.component, 120); str(target.build, 200, true);
          if (typeof target.required !== 'boolean') bad();
          date(target.deployedAt, true); if (target.deployedBy !== null) id(target.deployedBy);
          str(target.deploymentEvidence, 8000);
        }
        for (const raw of issue.runs) {
          const run = record(raw); id(run.id); id(run.targetId); id(run.testerId);
          if (runIds.has(run.id) || sequences.has(run.sequence)) bad(); runIds.add(run.id); sequences.add(run.sequence);
          integer(run.sequence, 1); integer(run.fixCycle, 1, issue.fixCycle);
          str(run.environment, 120, true); str(run.component, 120); str(run.build, 200, true); str(run.note, 8000); date(run.createdAt);
          if (!['pass', 'fail', 'blocked'].includes(run.result)) bad();
          if (run.fixCycle === issue.fixCycle && !issue.targets.some(t => t.id === run.targetId && t.build === run.build && t.environment === run.environment && t.component === run.component)) bad();
        }
      } else {
        id(row.issue_id); date(row.created_at);
        if (table !== 'qa_slack_links') id(row.actor_id ?? row.uploaded_by);
        else { str(row.team_id, 100, true); str(row.channel_id, 100, true); str(row.thread_ts, 100, true); str(row.card_ts, 100, true); }
        if (table === 'qa_comments') str(row.body, 20000, true);
        if (table === 'qa_events') { integer(row.version, 1); str(row.type, 100, true); str(row.detail, 20000); }
        if (table === 'qa_commands' && (!/^[A-Za-z0-9][A-Za-z0-9_:-]{7,199}$/.test(row.id) || !/^[a-f0-9]{64}$/.test(row.payload_hash) || !row.response)) bad();
        if (table === 'qa_uploads' || table === 'qa_attachments') {
          integer(Number(row.size), 1, QA_MAX_FILE_BYTES); str(row.file_name, 255, true); str(row.mime_type, 100, true);
          if (row.storage_path !== `default/${row.issue_id}/${row.id}`) bad();
          if (table === 'qa_uploads') { date(row.expires_at); date(row.completed_at, true); }
        }
      }
    }
  }
  for(const table of ['qa_project_coordination','qa_coordination_commands']) {
    const rows=tables[table]??[]; if(!Array.isArray(rows)||rows.length>100000)bad();const ids=new Set<string>();
    for(const raw of rows){const row=record(raw);id(row.id);if(row.workspace_id!=='default'||ids.has(row.id))bad();ids.add(row.id);
      if(table==='qa_project_coordination'){if(row.coordinator_id!==null)id(row.coordinator_id);integer(row.version,1);id(row.updated_by);date(row.updated_at);}
      else{id(row.project_id);id(row.actor_id);str(row.payload_hash,64,true);record(row.response);date(row.created_at);}
    }tables[table]=rows;
  }
  return tables;
}
