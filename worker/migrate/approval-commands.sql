-- Atomic approval commands. Only the verified server adapter can insert contexts;
-- /api/query never exposes contexts, receipts, or delivery jobs. Context authority
-- lasts for one INSERT statement: its AFTER trigger deletes it before committing.
CREATE UNIQUE INDEX IF NOT EXISTS approval_one_pending_task ON approval_requests(workspace_id,task_id) WHERE status='pending';
CREATE UNIQUE INDEX IF NOT EXISTS approval_action_command ON approval_actions(workspace_id,command_id) WHERE command_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS approval_command_contexts (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  task_id TEXT NOT NULL, request_id TEXT, operation TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)), payload_hash TEXT NOT NULL,
  event_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS approval_command_receipts (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, actor_id TEXT NOT NULL,
  task_id TEXT NOT NULL, request_id TEXT, payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK(json_valid(result_json)), created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id)
);
CREATE TABLE IF NOT EXISTS approval_events (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  request_id TEXT, actor_id TEXT NOT NULL, command_id TEXT NOT NULL,
  operation TEXT NOT NULL, request_version INTEGER, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,id), UNIQUE(workspace_id,command_id)
);
CREATE TABLE IF NOT EXISTS approval_delivery_outbox (
  workspace_id TEXT NOT NULL, id TEXT NOT NULL, task_id TEXT NOT NULL,
  request_id TEXT, event_id TEXT NOT NULL, recipient_id TEXT, team_id TEXT NOT NULL, target_id TEXT NOT NULL,
  delivery_type TEXT NOT NULL CHECK(delivery_type IN ('channel','dm')),
  operation TEXT NOT NULL, request_version INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','skipped','failed','review')),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT NOT NULL,
  lease_token TEXT, lease_expires_at TEXT, delivered_ts TEXT,
  last_error TEXT, created_at TEXT NOT NULL, delivered_at TEXT,
  PRIMARY KEY(workspace_id,id)
);
CREATE INDEX IF NOT EXISTS approval_delivery_due ON approval_delivery_outbox(state,next_attempt_at);
CREATE TABLE IF NOT EXISTS approval_delivery_threads (
  workspace_id TEXT NOT NULL, team_id TEXT NOT NULL, task_id TEXT NOT NULL, channel_id TEXT NOT NULL,
  thread_ts TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id,team_id,task_id,channel_id)
);

-- Dropped and recreated on every run so existing databases receive policy changes.
DROP TRIGGER IF EXISTS approval_command_validate;
CREATE TRIGGER IF NOT EXISTS approval_command_validate BEFORE INSERT ON approval_command_contexts
BEGIN
  SELECT RAISE(ABORT,'approval_invalid_input') WHERE NEW.operation NOT IN ('submit','approve','reject','return','withdraw','set_requirement')
    OR length(NEW.id) NOT BETWEEN 8 AND 200 OR json_extract(NEW.payload,'$.commandId') IS NOT NEW.id
    OR json_extract(NEW.payload,'$.operation') IS NOT NEW.operation;
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(
    SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND is_active=1);
  SELECT RAISE(ABORT,'approval_unavailable') WHERE NOT EXISTS(
    SELECT 1 FROM tasks t JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
    WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND (p.is_archived=0 OR NEW.operation='withdraw'));
  SELECT RAISE(ABORT,'approval_idempotency_conflict') WHERE EXISTS(
    SELECT 1 FROM approval_command_receipts WHERE workspace_id=NEW.workspace_id AND id=NEW.id);
  SELECT RAISE(ABORT,'approval_disabled') WHERE NEW.operation NOT IN ('withdraw','set_requirement') AND NOT COALESCE(
    (SELECT CASE WHEN json_type(value,'$.approvals') IN ('true','false') THEN json_extract(value,'$.approvals') END
      FROM system_settings WHERE workspace_id=NEW.workspace_id AND key='feature_toggles'),
    EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id) OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id));
  -- Anyone who may edit a task can require approval; only a live administrator may remove it.
  SELECT RAISE(ABORT,'approval_requirement_admin_only') WHERE NEW.operation='set_requirement'
    AND json_type(NEW.payload,'$.enabled') IS NOT 'true' AND NOT EXISTS(
      SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.actor_id AND is_active=1 AND role IN ('admin','super_admin'));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation='set_requirement' AND (
    json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id OR NOT EXISTS(
      SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
      AND requires_approval=json_extract(NEW.payload,'$.expectedRequiresApproval')
      AND current_approval_id IS NULL AND approval_status IS NULL)
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND status='pending'));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation='submit' AND (
    json_extract(NEW.payload,'$.taskId') IS NOT NEW.task_id OR NOT EXISTS(
      SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id
        AND status_id=json_extract(NEW.payload,'$.expected.statusId')
        AND requires_approval=json_extract(NEW.payload,'$.expected.requiresApproval')
        AND current_approval_id IS json_extract(NEW.payload,'$.expected.currentApprovalId')
        AND approval_status IS json_extract(NEW.payload,'$.expected.approvalStatus')
        AND current_approval_id IS NULL AND approval_status IS NULL)
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND task_id=NEW.task_id AND status='pending'));
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='submit' AND (
    (SELECT count(*) FROM approval_rules r JOIN tasks t ON t.project_id=r.project_id AND t.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND r.is_active=1
      AND r.from_status=t.status_id AND r.to_status=json_extract(NEW.payload,'$.toStatusId'))>1
    OR json_extract(NEW.payload,'$.expectedRuleId') IS NOT (
      SELECT r.id FROM approval_rules r JOIN tasks t ON t.project_id=r.project_id AND t.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND t.id=NEW.task_id AND r.is_active=1
      AND r.from_status=t.status_id AND r.to_status=json_extract(NEW.payload,'$.toStatusId'))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=json_extract(NEW.payload,'$.toStatusId'))
    OR json_extract(NEW.payload,'$.toStatusId') IS json_extract(NEW.payload,'$.expected.statusId'));
  SELECT RAISE(ABORT,'approval_not_required') WHERE NEW.operation='submit' AND json_extract(NEW.payload,'$.expectedRuleId') IS NULL
    AND json_extract(NEW.payload,'$.enableRequirement')=0
    AND EXISTS(SELECT 1 FROM tasks WHERE workspace_id=NEW.workspace_id AND id=NEW.task_id AND requires_approval=0);
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='submit' AND json_extract(NEW.payload,'$.expectedRuleId') IS NOT NULL AND (
    NOT EXISTS(SELECT 1 FROM approval_rule_steps WHERE workspace_id=NEW.workspace_id AND rule_id=json_extract(NEW.payload,'$.expectedRuleId'))
    OR (SELECT count(*) FROM approval_rule_steps WHERE rule_id=json_extract(NEW.payload,'$.expectedRuleId'))>100
    OR EXISTS(SELECT 1 FROM approval_rule_steps s WHERE s.rule_id=json_extract(NEW.payload,'$.expectedRuleId') AND (
      s.workspace_id<>NEW.workspace_id OR s.step_order<1
      OR s.step_order<>(SELECT count(*) FROM approval_rule_steps x WHERE x.rule_id=s.rule_id AND x.step_order<=s.step_order)
      OR (s.approver_type='role' AND (s.approver_role NOT IN ('member','admin','super_admin') OR s.approver_role IS NULL OR s.approver_user_id IS NOT NULL))
      OR (s.approver_type='user' AND (s.approver_role IS NOT NULL OR NOT EXISTS(
        SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=s.approver_user_id AND is_active=1))))));
  SELECT RAISE(ABORT,'approval_conflict') WHERE NEW.operation IN ('approve','reject','return','withdraw') AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND r.task_id=NEW.task_id
      AND r.id=json_extract(NEW.payload,'$.requestId') AND r.status='pending'
      AND r.version=json_extract(NEW.payload,'$.expectedVersion')
      AND (NEW.operation='withdraw' OR r.current_step=json_extract(NEW.payload,'$.expectedStep'))
      AND t.current_approval_id=r.id AND t.approval_status='pending_approval' AND t.status_id=r.from_status);
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.operation='withdraw' AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN members m ON m.id=NEW.actor_id AND m.workspace_id=r.workspace_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
      AND (r.requested_by=NEW.actor_id OR m.role IN ('admin','super_admin')));
  -- A requester never decides their own request, whatever their role; it waits for
  -- another approver or is withdrawn.
  SELECT RAISE(ABORT,'approval_self_decision_forbidden') WHERE NEW.operation IN ('approve','reject','return') AND EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id AND requested_by=NEW.actor_id);
  -- Legacy pending requests have no trustworthy snapshot. They can be withdrawn
  -- and resubmitted, but must never be reinterpreted using an edited live rule.
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation IN ('approve','reject','return') AND NOT EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id
      AND json_valid(steps_snapshot) AND json_type(steps_snapshot)='array' AND json_array_length(steps_snapshot)>0
      AND current_step BETWEEN 1 AND json_array_length(steps_snapshot));
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.operation IN ('approve','reject','return') AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN members m ON m.id=NEW.actor_id AND m.workspace_id=r.workspace_id AND m.is_active=1
      JOIN json_each(r.steps_snapshot) s ON CAST(s.key AS INTEGER)+1=r.current_step
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND (
      (json_extract(s.value,'$.approver_type')='user' AND json_extract(s.value,'$.approver_user_id')=m.id)
      OR (json_extract(s.value,'$.approver_type')='role' AND json_extract(s.value,'$.approver_role')=m.role)
      OR (r.rule_id IS NULL AND m.role IN ('admin','super_admin'))));
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.operation='approve' AND NOT EXISTS(
    SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id);
  SELECT RAISE(ABORT,'approval_transition_prerequisite') WHERE (NEW.operation='submit' OR (NEW.operation='approve' AND EXISTS(
    SELECT 1 FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id AND current_step=json_array_length(steps_snapshot))))
    AND EXISTS(SELECT 1 FROM status_transition_rules x WHERE x.workspace_id=NEW.workspace_id
      AND x.target_status_id=CASE WHEN NEW.operation='submit' THEN json_extract(NEW.payload,'$.toStatusId') ELSE (
        SELECT to_status FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id) END
      AND NOT EXISTS(SELECT 1 FROM status_logs l WHERE l.workspace_id=NEW.workspace_id AND l.task_id=NEW.task_id AND l.to_status_id=x.required_status_id));
END;

DROP TRIGGER IF EXISTS approval_command_apply;
CREATE TRIGGER IF NOT EXISTS approval_command_apply AFTER INSERT ON approval_command_contexts
BEGIN
  INSERT INTO approval_requests(workspace_id,id,task_id,rule_id,requested_by,from_status,to_status,current_step,status,created_at,version,steps_snapshot,rule_snapshot)
    SELECT NEW.workspace_id,NEW.request_id,t.id,json_extract(NEW.payload,'$.expectedRuleId'),NEW.actor_id,t.status_id,
      json_extract(NEW.payload,'$.toStatusId'),1,'pending',NEW.created_at,1,
      CASE WHEN json_extract(NEW.payload,'$.expectedRuleId') IS NULL THEN '[{"step_order":1,"approver_type":"role","approver_role":"admin","approver_user_id":null}]'
      ELSE (SELECT json_group_array(json(step)) FROM (SELECT json_object('step_order',s.step_order,'approver_type',s.approver_type,
        'approver_role',s.approver_role,'approver_user_id',s.approver_user_id) AS step FROM approval_rule_steps s
        WHERE s.workspace_id=NEW.workspace_id AND s.rule_id=json_extract(NEW.payload,'$.expectedRuleId') ORDER BY s.step_order)) END,
      CASE WHEN json_extract(NEW.payload,'$.expectedRuleId') IS NULL THEN NULL ELSE (SELECT json_object('id',r.id,
        'project_id',r.project_id,'from_status',r.from_status,'to_status',r.to_status) FROM approval_rules r
        WHERE r.workspace_id=NEW.workspace_id AND r.id=json_extract(NEW.payload,'$.expectedRuleId')) END
    FROM tasks t WHERE NEW.operation='submit' AND t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  INSERT INTO approval_actions(workspace_id,id,request_id,step_order,action_by,action,comment,acted_at,command_id,request_version)
    SELECT NEW.workspace_id,NEW.event_id,NEW.request_id,r.current_step,NEW.actor_id,NEW.operation,
      json_extract(NEW.payload,'$.comment'),NEW.created_at,NEW.id,r.version+1 FROM approval_requests r
    WHERE NEW.operation IN ('approve','reject','return') AND r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id;
  INSERT INTO status_logs(workspace_id,id,task_id,from_status_id,to_status_id,changed_by,changed_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.task_id,r.from_status,r.to_status,NEW.actor_id,NEW.created_at
    FROM approval_requests r WHERE NEW.operation='approve' AND r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
      AND r.current_step=json_array_length(r.steps_snapshot);
  UPDATE tasks SET
    status_id=(SELECT to_status FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id),
    started_at=CASE WHEN started_at IS NULL AND EXISTS(SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND s.auto_start=1) THEN substr(NEW.created_at,1,10) ELSE started_at END,
    completed_at=CASE WHEN EXISTS(SELECT 1 FROM approval_requests r JOIN statuses s ON s.id=r.to_status AND s.workspace_id=r.workspace_id
      WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND s.is_done=1)
      THEN CASE WHEN EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=tasks.status_id AND is_done=1) THEN completed_at ELSE NEW.created_at END ELSE NULL END,
    approval_status=NULL,current_approval_id=NULL
    WHERE NEW.operation='approve' AND workspace_id=NEW.workspace_id AND id=NEW.task_id
      AND EXISTS(SELECT 1 FROM approval_requests r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id
        AND r.current_step=json_array_length(r.steps_snapshot));
  UPDATE approval_requests SET version=version+1,
    status=CASE WHEN NEW.operation='withdraw' THEN 'cancelled' WHEN NEW.operation='reject' THEN 'rejected'
      WHEN NEW.operation='return' THEN 'returned' WHEN current_step=json_array_length(steps_snapshot) THEN 'approved' ELSE 'pending' END,
    completed_at=CASE WHEN NEW.operation<>'approve' OR current_step=json_array_length(steps_snapshot) THEN NEW.created_at ELSE NULL END,
    current_step=CASE WHEN NEW.operation='approve' AND current_step<json_array_length(steps_snapshot) THEN current_step+1 ELSE current_step END
    WHERE NEW.operation IN ('approve','reject','return','withdraw') AND workspace_id=NEW.workspace_id AND id=NEW.request_id;
  UPDATE tasks SET approval_status=NULL,current_approval_id=NULL WHERE NEW.operation IN ('reject','return','withdraw')
    AND workspace_id=NEW.workspace_id AND id=NEW.task_id AND current_approval_id=NEW.request_id;
  UPDATE tasks SET approval_status='pending_approval',current_approval_id=NEW.request_id,
    requires_approval=CASE WHEN json_extract(NEW.payload,'$.enableRequirement')=1 THEN 1 ELSE requires_approval END
    WHERE NEW.operation='submit' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
  UPDATE tasks SET requires_approval=json_extract(NEW.payload,'$.enabled')
    WHERE NEW.operation='set_requirement' AND workspace_id=NEW.workspace_id AND id=NEW.task_id;
  INSERT INTO approval_events(workspace_id,id,task_id,request_id,actor_id,command_id,operation,request_version,created_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.task_id,NEW.request_id,NEW.actor_id,NEW.id,NEW.operation,
      (SELECT version FROM approval_requests WHERE workspace_id=NEW.workspace_id AND id=NEW.request_id),NEW.created_at;
  INSERT INTO activity_logs(workspace_id,id,user_id,action,target_type,task_id,task_key,detail,created_at)
    SELECT NEW.workspace_id,NEW.event_id,NEW.actor_id,'approval_'||NEW.operation,'task',t.id,t.task_key,
      json_object('commandId',NEW.id,'requestId',NEW.request_id,'operation',NEW.operation),NEW.created_at
      FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  INSERT INTO notifications(workspace_id,id,recipient_id,sender_id,type,task_id,content,is_read,created_at)
    SELECT NEW.workspace_id,NEW.event_id||':'||m.id,m.id,NEW.actor_id,
      CASE WHEN r.status='pending' THEN 'approval_requested' ELSE 'approval_completed' END,NEW.task_id,
      json_object('kind','approval','requestId',r.id,'taskTitle',t.title,'operation',NEW.operation,'version',r.version),0,NEW.created_at
    FROM approval_requests r JOIN tasks t ON t.workspace_id=r.workspace_id AND t.id=r.task_id
    JOIN members m ON m.workspace_id=r.workspace_id AND m.is_active=1 AND m.id<>NEW.actor_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND NEW.operation IN ('submit','approve','reject','return')
      AND ((r.status<>'pending' AND m.id=r.requested_by) OR (r.status='pending' AND m.id<>r.requested_by AND EXISTS(
        SELECT 1 FROM json_each(r.steps_snapshot) s WHERE CAST(s.key AS INTEGER)+1=r.current_step AND (
          (json_extract(s.value,'$.approver_type')='user' AND json_extract(s.value,'$.approver_user_id')=m.id)
          OR (json_extract(s.value,'$.approver_type')='role' AND json_extract(s.value,'$.approver_role')=m.role)
          OR (r.rule_id IS NULL AND m.role IN ('admin','super_admin'))))));
  INSERT INTO approval_delivery_outbox(workspace_id,id,task_id,request_id,event_id,recipient_id,team_id,target_id,delivery_type,operation,request_version,next_attempt_at,created_at)
    SELECT DISTINCT NEW.workspace_id,NEW.event_id||':channel:'||json_extract(route.value,'$.channelId'),NEW.task_id,NEW.request_id,NEW.event_id,NULL,
      json_extract(s.value,'$.teamId'),json_extract(route.value,'$.channelId'),'channel',NEW.operation,r.version,NEW.created_at,NEW.created_at
    FROM approval_requests r JOIN tasks t ON t.id=r.task_id AND t.workspace_id=r.workspace_id
      JOIN projects p ON p.id=t.project_id AND p.workspace_id=t.workspace_id
      JOIN system_settings s ON s.workspace_id=r.workspace_id AND s.key='slack_delivery' AND json_valid(s.value)
      JOIN json_each(CASE WHEN json_type(s.value,'$.routes')='array' THEN json_extract(s.value,'$.routes') ELSE '[]' END) route
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id AND NEW.operation IN ('submit','approve','reject','return')
      AND json_extract(s.value,'$.enabled')=1 AND json_type(s.value,'$.teamId')='text'
      AND json_type(route.value,'$.channelId')='text' AND COALESCE(json_extract(route.value,'$.enabled'),1)=1
      AND (json_extract(route.value,'$.projectId')=p.id OR json_extract(route.value,'$.lineId')=p.line_id);
  INSERT INTO approval_delivery_outbox(workspace_id,id,task_id,request_id,event_id,recipient_id,team_id,target_id,delivery_type,operation,request_version,next_attempt_at,created_at)
    SELECT NEW.workspace_id,NEW.event_id||':dm:'||n.recipient_id,NEW.task_id,NEW.request_id,NEW.event_id,n.recipient_id,
      json_extract(s.value,'$.teamId'),n.recipient_id,'dm',NEW.operation,r.version,NEW.created_at,NEW.created_at
    FROM notifications n JOIN approval_requests r ON r.workspace_id=n.workspace_id AND r.id=NEW.request_id
      JOIN system_settings s ON s.workspace_id=n.workspace_id AND s.key='slack_delivery' AND json_valid(s.value)
    WHERE n.workspace_id=NEW.workspace_id AND n.id LIKE NEW.event_id||':%' AND json_extract(s.value,'$.enabled')=1
       AND json_extract(s.value,'$.dmEnabled')=1 AND json_type(s.value,'$.teamId')='text'
       AND EXISTS(SELECT 1 FROM approval_delivery_outbox q WHERE q.workspace_id=NEW.workspace_id AND q.event_id=NEW.event_id AND q.delivery_type='channel')
      AND (json_type(s.value,'$.dmMemberIds') IS NULL OR EXISTS(SELECT 1 FROM json_each(s.value,'$.dmMemberIds') m WHERE m.value=n.recipient_id));
  INSERT INTO approval_command_receipts(workspace_id,id,actor_id,task_id,request_id,payload_hash,result_json,created_at)
    SELECT NEW.workspace_id,NEW.id,NEW.actor_id,NEW.task_id,NEW.request_id,NEW.payload_hash,
      json_object('commandId',NEW.id,'replayed',json('false'),'eventId',NEW.event_id,
        'request',CASE WHEN NEW.request_id IS NULL THEN NULL ELSE (SELECT json_object('id',r.id,'task_id',r.task_id,'rule_id',r.rule_id,
          'requested_by',r.requested_by,'from_status',r.from_status,'to_status',r.to_status,'current_step',r.current_step,'status',r.status,
          'version',r.version,'steps_snapshot',CASE WHEN r.steps_snapshot IS NULL THEN NULL ELSE json(r.steps_snapshot) END,
          'rule_snapshot',CASE WHEN r.rule_snapshot IS NULL THEN NULL ELSE json(r.rule_snapshot) END,'created_at',r.created_at,'completed_at',r.completed_at)
          FROM approval_requests r WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.request_id) END,
        'task',json_object('id',t.id,'status_id',t.status_id,'requires_approval',json(CASE WHEN t.requires_approval=1 THEN 'true' ELSE 'false' END),
          'approval_status',t.approval_status,'current_approval_id',t.current_approval_id,'started_at',t.started_at,'completed_at',t.completed_at)),NEW.created_at
      FROM tasks t WHERE t.workspace_id=NEW.workspace_id AND t.id=NEW.task_id;
  DELETE FROM approval_command_contexts WHERE workspace_id=NEW.workspace_id AND id=NEW.id;
END;

-- Contexts cannot remain reusable. Exactly one command context exists during a
-- statement, and every protected write must concern its task/request/operation.
CREATE TRIGGER IF NOT EXISTS approval_request_command_insert BEFORE INSERT ON approval_requests
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(SELECT 1 FROM approval_command_contexts c
    WHERE c.workspace_id=NEW.workspace_id AND c.request_id=NEW.id AND c.task_id=NEW.task_id
      AND c.actor_id=NEW.requested_by AND c.operation='submit');
END;
CREATE TRIGGER IF NOT EXISTS approval_request_command_update BEFORE UPDATE ON approval_requests
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.workspace_id<>OLD.workspace_id OR NEW.task_id<>OLD.task_id
    OR NEW.rule_id IS NOT OLD.rule_id OR NEW.requested_by<>OLD.requested_by OR NEW.from_status<>OLD.from_status
    OR NEW.to_status<>OLD.to_status OR NEW.steps_snapshot IS NOT OLD.steps_snapshot OR NEW.rule_snapshot IS NOT OLD.rule_snapshot
    OR NEW.version<>OLD.version+1 OR NOT EXISTS(SELECT 1 FROM approval_command_contexts c
      WHERE c.workspace_id=OLD.workspace_id AND c.request_id=OLD.id AND c.task_id=OLD.task_id
      AND c.operation IN ('approve','reject','return','withdraw'));
END;
CREATE TRIGGER IF NOT EXISTS approval_request_pending_delete BEFORE DELETE ON approval_requests WHEN OLD.status='pending'
BEGIN SELECT RAISE(ABORT,'approval_conflict'); END;
CREATE TRIGGER IF NOT EXISTS approval_action_command_insert BEFORE INSERT ON approval_actions
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NOT EXISTS(SELECT 1 FROM approval_command_contexts c
    WHERE c.workspace_id=NEW.workspace_id AND c.request_id=NEW.request_id AND c.actor_id=NEW.action_by
      AND c.id=NEW.command_id AND c.operation=NEW.action);
END;
CREATE TRIGGER IF NOT EXISTS approval_action_immutable BEFORE UPDATE ON approval_actions
BEGIN SELECT RAISE(ABORT,'approval_forbidden'); END;
CREATE TRIGGER IF NOT EXISTS approval_task_command_update BEFORE UPDATE ON tasks
WHEN NEW.approval_status IS NOT OLD.approval_status OR NEW.current_approval_id IS NOT OLD.current_approval_id
  OR NEW.requires_approval<>OLD.requires_approval
  OR ((OLD.current_approval_id IS NOT NULL OR OLD.approval_status='pending_approval'
    OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND task_id=OLD.id AND status='pending'))
    AND (NEW.status_id<>OLD.status_id OR NEW.project_id<>OLD.project_id))
  OR (NEW.status_id<>OLD.status_id AND OLD.requires_approval=1 AND COALESCE(
    (SELECT CASE WHEN json_type(value,'$.approvals') IN ('true','false') THEN json_extract(value,'$.approvals') END
      FROM system_settings WHERE workspace_id=OLD.workspace_id AND key='feature_toggles'),
    EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=OLD.workspace_id) OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id)))
BEGIN
  SELECT RAISE(ABORT,'approval_forbidden') WHERE NEW.workspace_id<>OLD.workspace_id OR NOT EXISTS(
    SELECT 1 FROM approval_command_contexts c WHERE c.workspace_id=OLD.workspace_id AND c.task_id=OLD.id
      AND c.operation IN ('submit','approve','reject','return','withdraw','set_requirement'));
END;
CREATE TRIGGER IF NOT EXISTS approval_task_pending_delete BEFORE DELETE ON tasks
WHEN OLD.current_approval_id IS NOT NULL OR OLD.approval_status='pending_approval'
 OR EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND task_id=OLD.id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_conflict'); END;
CREATE TRIGGER IF NOT EXISTS approval_task_no_pointer_insert BEFORE INSERT ON tasks
WHEN NEW.current_approval_id IS NOT NULL OR NEW.approval_status IS NOT NULL
BEGIN SELECT RAISE(ABORT,'approval_forbidden'); END;
CREATE TRIGGER IF NOT EXISTS approval_rule_pending_update BEFORE UPDATE ON approval_rules
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_rule_workspace_insert BEFORE INSERT ON approval_rules
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE
    (NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.from_status)
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.to_status)
    OR NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.created_by AND is_active=1)
    OR NEW.from_status=NEW.to_status;
END;
CREATE TRIGGER IF NOT EXISTS approval_rule_workspace_update BEFORE UPDATE ON approval_rules
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.workspace_id<>OLD.workspace_id
    OR (NEW.project_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM projects WHERE workspace_id=NEW.workspace_id AND id=NEW.project_id AND is_archived=0))
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.from_status)
    OR NOT EXISTS(SELECT 1 FROM statuses WHERE workspace_id=NEW.workspace_id AND id=NEW.to_status) OR NEW.from_status=NEW.to_status;
END;
CREATE TRIGGER IF NOT EXISTS approval_step_workspace_insert BEFORE INSERT ON approval_rule_steps
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NOT EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id AND id=NEW.rule_id)
    OR (NEW.approver_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.approver_user_id AND is_active=1));
END;
CREATE TRIGGER IF NOT EXISTS approval_step_workspace_update BEFORE UPDATE ON approval_rule_steps
BEGIN
  SELECT RAISE(ABORT,'approval_rule_invalid') WHERE NEW.workspace_id<>OLD.workspace_id OR NOT EXISTS(SELECT 1 FROM approval_rules WHERE workspace_id=NEW.workspace_id AND id=NEW.rule_id)
    OR (NEW.approver_user_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM members WHERE workspace_id=NEW.workspace_id AND id=NEW.approver_user_id AND is_active=1));
END;
CREATE TRIGGER IF NOT EXISTS approval_rule_history_delete BEFORE DELETE ON approval_rules
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.id)
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_insert BEFORE INSERT ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=NEW.rule_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_update BEFORE UPDATE ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id IN (OLD.rule_id,NEW.rule_id) AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_step_pending_delete BEFORE DELETE ON approval_rule_steps
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE rule_id=OLD.rule_id AND status='pending')
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_status_pending_delete BEFORE DELETE ON statuses
WHEN EXISTS(SELECT 1 FROM approval_requests WHERE workspace_id=OLD.workspace_id AND status='pending' AND (from_status=OLD.id OR to_status=OLD.id))
BEGIN SELECT RAISE(ABORT,'approval_rule_in_use'); END;
CREATE TRIGGER IF NOT EXISTS approval_project_pending_update BEFORE UPDATE ON projects
WHEN NEW.is_archived<>OLD.is_archived OR NEW.workspace_id<>OLD.workspace_id
BEGIN
  SELECT RAISE(ABORT,'approval_rule_in_use') WHERE EXISTS(SELECT 1 FROM approval_requests r JOIN tasks t ON t.id=r.task_id
    WHERE t.project_id=OLD.id AND r.status='pending');
END;
