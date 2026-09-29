-- 签核规则
CREATE TABLE IF NOT EXISTS approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  from_status VARCHAR(50) NOT NULL,  -- 对应 statuses.name（无外键约束，statuses 无唯一 name 索引）
  to_status VARCHAR(50) NOT NULL,    -- 同上
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, from_status, to_status)
);
CREATE INDEX IF NOT EXISTS idx_approval_rules_project ON approval_rules(project_id);

-- 签核层级
CREATE TABLE IF NOT EXISTS approval_rule_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id UUID NOT NULL REFERENCES approval_rules(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  approver_type VARCHAR(10) NOT NULL CHECK (approver_type IN ('role', 'user')),
  approver_role VARCHAR(50),
  approver_user_id TEXT,
  allow_delegate BOOLEAN NOT NULL DEFAULT FALSE,
  timeout_hours INTEGER,
  timeout_action VARCHAR(20) CHECK (timeout_action IN ('remind', 'auto_approve', 'escalate')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(rule_id, step_order)
);
CREATE INDEX IF NOT EXISTS idx_approval_steps_rule ON approval_rule_steps(rule_id);

-- 签核请求
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  rule_id UUID NOT NULL REFERENCES approval_rules(id),
  requested_by TEXT NOT NULL,
  from_status VARCHAR(50) NOT NULL,
  to_status VARCHAR(50) NOT NULL,
  current_step INTEGER NOT NULL DEFAULT 1,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'returned', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_task ON approval_requests(task_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);

-- 签核操作记录
CREATE TABLE IF NOT EXISTS approval_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES approval_requests(id) ON DELETE CASCADE,
  step_order INTEGER NOT NULL,
  action_by TEXT NOT NULL,
  action VARCHAR(10) NOT NULL CHECK (action IN ('approve', 'reject', 'return')),
  comment TEXT,
  acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_approval_actions_request ON approval_actions(request_id);

-- tasks 表新增栏位（检查是否已存在）
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='approval_status') THEN
    ALTER TABLE tasks ADD COLUMN approval_status VARCHAR(20) DEFAULT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='current_approval_id') THEN
    ALTER TABLE tasks ADD COLUMN current_approval_id UUID;
  END IF;
END $$;

-- RLS
ALTER TABLE approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rule_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all_approval_rules" ON approval_rules;
CREATE POLICY "authenticated_all_approval_rules" ON approval_rules FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_approval_rule_steps" ON approval_rule_steps;
CREATE POLICY "authenticated_all_approval_rule_steps" ON approval_rule_steps FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_approval_requests" ON approval_requests;
CREATE POLICY "authenticated_all_approval_requests" ON approval_requests FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_approval_actions" ON approval_actions;
CREATE POLICY "authenticated_all_approval_actions" ON approval_actions FOR ALL TO authenticated USING (true) WITH CHECK (true);
