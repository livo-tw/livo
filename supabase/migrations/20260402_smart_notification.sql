-- ============================================================
-- Smart Notification Sync
-- 20260402_smart_notification.sql
-- Note: projects.id and tasks.id are TEXT in this schema,
--       so we do NOT use UUID foreign keys for those columns.
-- ============================================================

-- ── 1. notification_templates ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_templates (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  text,                          -- 暂不做外键，NULL = 全局
  name             text NOT NULL,
  event_type       text NOT NULL
    CHECK (event_type IN (
      'task_created', 'status_changed', 'assignee_changed',
      'due_reminder', 'overdue', 'approval_requested',
      'approval_completed', 'comment_added', 'custom'
    )),
  template_content text NOT NULL DEFAULT '',      -- 支援 {{variable}} 語法
  tone             text NOT NULL DEFAULT 'neutral'
    CHECK (tone IN ('neutral', 'celebration', 'urgent', 'warning', 'friendly')),
  is_default       boolean NOT NULL DEFAULT false,
  created_by       text,                          -- members.id (text)
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_templates_event
  ON public.notification_templates(event_type);

-- Unique name ensures INSERT idempotency via ON CONFLICT below
CREATE UNIQUE INDEX IF NOT EXISTS uq_notification_templates_name
  ON public.notification_templates(name);

-- ── 2. notification_rules ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_rules (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              text,                   -- projects.id (text), NULL = 全域
  event_type              text NOT NULL
    CHECK (event_type IN (
      'task_created', 'status_changed', 'assignee_changed',
      'due_reminder', 'overdue', 'approval_requested',
      'approval_completed', 'comment_added', 'custom'
    )),
  from_status             text,                   -- NULL = 任意来源状态
  to_status               text,                   -- NULL = 任意目标状态
  is_enabled              boolean NOT NULL DEFAULT true,
  template_id             uuid REFERENCES public.notification_templates(id) ON DELETE SET NULL,
  target_channels         jsonb NOT NULL DEFAULT '[]',   -- [{type:"slack",target:"#channel"}]
  priority_overrides      jsonb NOT NULL DEFAULT '{}',   -- {high:"urgent",low:"friendly"}
  auto_send               boolean NOT NULL DEFAULT false,
  auto_send_delay_seconds integer NOT NULL DEFAULT 3,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_rules_event
  ON public.notification_rules(event_type);
CREATE INDEX IF NOT EXISTS idx_notification_rules_project
  ON public.notification_rules(project_id);

-- ── 3. notification_delivery_logs ───────────────────────────
CREATE TABLE IF NOT EXISTS public.notification_delivery_logs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id          uuid REFERENCES public.notification_rules(id) ON DELETE SET NULL,
  task_id          text,                          -- tasks.id (text)
  event_type       text NOT NULL
    CHECK (event_type IN (
      'task_created', 'status_changed', 'assignee_changed',
      'due_reminder', 'overdue', 'approval_requested',
      'approval_completed', 'comment_added', 'custom'
    )),
  triggered_by     text,                          -- members.id
  message_content  text NOT NULL DEFAULT '',
  was_customized   boolean NOT NULL DEFAULT false,
  channel_type     text NOT NULL DEFAULT '',      -- 'slack'|'webhook'|'email'|'in_app'
  channel_target   text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent', 'failed', 'skipped')),
  error_message    text,
  sent_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_logs_task
  ON public.notification_delivery_logs(task_id);
CREATE INDEX IF NOT EXISTS idx_delivery_logs_sent_at
  ON public.notification_delivery_logs(sent_at DESC);

-- ── 4. due_date_reminders ────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.due_date_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id       text NOT NULL,                    -- tasks.id (text)
  remind_at     timestamptz NOT NULL,
  reminder_type text NOT NULL
    CHECK (reminder_type IN ('before_1day', 'due_day', 'overdue')),
  is_sent       boolean NOT NULL DEFAULT false,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_due_reminders_remind_at
  ON public.due_date_reminders(remind_at) WHERE NOT is_sent;
CREATE INDEX IF NOT EXISTS idx_due_reminders_task
  ON public.due_date_reminders(task_id);

-- ── 5. RLS ───────────────────────────────────────────────────
ALTER TABLE public.notification_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_delivery_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.due_date_reminders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "ntpl_all" ON public.notification_templates;
CREATE POLICY "ntpl_all" ON public.notification_templates
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "nrul_all" ON public.notification_rules;
CREATE POLICY "nrul_all" ON public.notification_rules
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "ndlog_all" ON public.notification_delivery_logs;
CREATE POLICY "ndlog_all" ON public.notification_delivery_logs
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "ddr_all" ON public.due_date_reminders;
CREATE POLICY "ddr_all" ON public.due_date_reminders
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- ── 6. 預設模板（9 種事件，繁體中文）────────────────────────────
INSERT INTO public.notification_templates
  (name, event_type, template_content, tone, is_default)
VALUES
  ('新建任務通知',   'task_created',
   '📋 新任務建立：{{task_name}}｜指派：{{assignee}}｜到期：{{due_date}}｜{{description_summary}}',
   'neutral', true),
  ('狀態變更通知',   'status_changed',
   '🔄 「{{task_name}}」狀態從「{{prev_status}}」變更為「{{status}}」｜負責人：{{assignee}}',
   'neutral', true),
  ('指派變更通知',   'assignee_changed',
   '👋 {{assignee}}，你被指派了新任務：「{{task_name}}」｜到期：{{due_date}}',
   'friendly', true),
  ('到期提醒',       'due_reminder',
   '⚠️ 提醒：「{{task_name}}」明天到期｜負責人：{{assignee}}',
   'warning', true),
  ('任務逾期警告',   'overdue',
   '🚨 「{{task_name}}」已逾期 {{overdue_days}} 天！｜負責人：{{assignee}}',
   'urgent', true),
  ('請求簽核',       'approval_requested',
   '⏳ 「{{task_name}}」需要你的簽核｜請盡快處理',
   'urgent', true),
  ('簽核完成',       'approval_completed',
   '✅ 「{{task_name}}」簽核已完成｜簽核人：{{approver}}',
   'celebration', true),
  ('新增評論通知',   'comment_added',
   '💬 「{{task_name}}」有新評論｜來自 {{reporter}}',
   'neutral', true),
  ('自定義通知',     'custom',
   '📢 {{task_name}}',
   'neutral', true)
ON CONFLICT (name) DO NOTHING;
