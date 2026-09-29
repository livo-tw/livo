-- 外部平台帐号绑定
CREATE TABLE IF NOT EXISTS external_account_bindings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id TEXT NOT NULL,  -- 关联 members 表
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('slack', 'teams', 'line')),
  platform_user_id VARCHAR(100) NOT NULL,
  platform_team_id VARCHAR(100),
  display_name VARCHAR(200),
  is_verified BOOLEAN NOT NULL DEFAULT FALSE,
  bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_active_at TIMESTAMPTZ,
  UNIQUE(platform, platform_user_id, platform_team_id)
);
CREATE INDEX IF NOT EXISTS idx_external_bindings_member ON external_account_bindings(member_id);
CREATE INDEX IF NOT EXISTS idx_external_bindings_platform ON external_account_bindings(platform, platform_user_id);

-- 外部平台操作记录
CREATE TABLE IF NOT EXISTS external_action_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id TEXT NOT NULL,
  binding_id UUID REFERENCES external_account_bindings(id),
  platform VARCHAR(20) NOT NULL,
  action_type VARCHAR(30) NOT NULL
    CHECK (action_type IN (
      'approval_approve', 'approval_reject', 'approval_return',
      'status_change', 'comment_add', 'task_view', 'task_assign',
      'slash_command'
    )),
  target_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  action_payload JSONB,
  result_status VARCHAR(20) NOT NULL DEFAULT 'success'
    CHECK (result_status IN ('success', 'failed', 'denied', 'expired')),
  error_message TEXT,
  platform_message_id VARCHAR(200),
  acted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_external_actions_member ON external_action_logs(member_id);
CREATE INDEX IF NOT EXISTS idx_external_actions_date ON external_action_logs(acted_at);

-- Slack Thread <-> Task 映射
CREATE TABLE IF NOT EXISTS slack_thread_mappings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slack_channel_id VARCHAR(50) NOT NULL,
  slack_thread_ts VARCHAR(50) NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  notification_type VARCHAR(30),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(slack_channel_id, slack_thread_ts)
);
CREATE INDEX IF NOT EXISTS idx_slack_threads_task ON slack_thread_mappings(task_id);

-- 互动按钮 Token
CREATE TABLE IF NOT EXISTS interaction_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(64) NOT NULL UNIQUE,
  action_type VARCHAR(30) NOT NULL,
  target_id UUID NOT NULL,
  platform VARCHAR(20) NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  is_used BOOLEAN NOT NULL DEFAULT FALSE,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_interaction_tokens_hash ON interaction_tokens(token_hash);

-- RLS
ALTER TABLE external_account_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_action_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE slack_thread_mappings ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "authenticated_all_external_bindings" ON external_account_bindings;
CREATE POLICY "authenticated_all_external_bindings" ON external_account_bindings FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_external_action_logs" ON external_action_logs;
CREATE POLICY "authenticated_all_external_action_logs" ON external_action_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_slack_thread_mappings" ON slack_thread_mappings;
CREATE POLICY "authenticated_all_slack_thread_mappings" ON slack_thread_mappings FOR ALL TO authenticated USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "authenticated_all_interaction_tokens" ON interaction_tokens;
CREATE POLICY "authenticated_all_interaction_tokens" ON interaction_tokens FOR ALL TO authenticated USING (true) WITH CHECK (true);
