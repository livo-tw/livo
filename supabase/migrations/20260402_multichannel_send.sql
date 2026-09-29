-- 发送目标配置
CREATE TABLE IF NOT EXISTS report_send_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,  -- NULL=全域
  report_type VARCHAR(20) NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly')),
  channel_type VARCHAR(20) NOT NULL CHECK (channel_type IN ('slack', 'email', 'line', 'webhook')),
  channel_config JSONB NOT NULL,
  -- slack: { channel_id, channel_name }
  -- email: { recipients: ["a@b.com"] }
  -- line: { notify_token: "xxx" }
  -- webhook: { url, method, headers }
  format VARCHAR(20) NOT NULL DEFAULT 'text'
    CHECK (format IN ('text', 'full', 'pdf')),
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_report_targets_project ON report_send_targets(project_id);
CREATE INDEX IF NOT EXISTS idx_report_targets_type ON report_send_targets(report_type);

-- 发送记录
CREATE TABLE IF NOT EXISTS report_send_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type VARCHAR(20) NOT NULL,
  target_id UUID REFERENCES report_send_targets(id) ON DELETE SET NULL,
  channel_type VARCHAR(20) NOT NULL,
  channel_target VARCHAR(200) NOT NULL,
  format VARCHAR(20) NOT NULL,
  content_preview TEXT,  -- 前200字
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  error_message TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  sent_by TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_report_logs_date ON report_send_logs(sent_at);

-- RLS
ALTER TABLE report_send_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE report_send_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "authenticated_all_report_send_targets" ON report_send_targets;
CREATE POLICY "authenticated_all_report_send_targets" ON report_send_targets FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "authenticated_all_report_send_logs" ON report_send_logs;
CREATE POLICY "authenticated_all_report_send_logs" ON report_send_logs FOR ALL TO authenticated USING (true) WITH CHECK (true);
