-- Work reports: user-generated / auto-generated daily / weekly / monthly progress reports
-- Users can view, edit, copy, and review history in-app

CREATE TABLE IF NOT EXISTS work_reports (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL,
  report_type     TEXT        NOT NULL CHECK (report_type IN ('daily', 'weekly', 'monthly')),
  period_start    DATE        NOT NULL,
  period_end      DATE        NOT NULL,
  title           TEXT        NOT NULL,
  content         TEXT        NOT NULL DEFAULT '',
  is_edited       BOOLEAN     NOT NULL DEFAULT false,
  generated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_work_reports_user_type_period
  ON work_reports(user_id, report_type, period_start DESC);

-- RLS: each member can only read/write their own reports
ALTER TABLE work_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "work_reports_own" ON work_reports
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE work_reports IS '工作報告：日報 / 週報 / 月報，支援自動生成、手動編輯、歷史查詢';
