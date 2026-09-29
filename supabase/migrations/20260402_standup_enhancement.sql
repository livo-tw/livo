-- 站會增強 migration
-- standup_sessions 表（如不存在先建立基礎結構）
CREATE TABLE IF NOT EXISTS public.standup_sessions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by   TEXT        NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at     TIMESTAMPTZ,
  sprint_id    UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 新增配置欄位（idempotent）
ALTER TABLE public.standup_sessions
  ADD COLUMN IF NOT EXISTS default_speak_duration INTEGER     NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS sort_mode              VARCHAR(20) NOT NULL DEFAULT 'by_member'
    CHECK (sort_mode IN ('by_member', 'by_project', 'by_due_date', 'by_department')),
  ADD COLUMN IF NOT EXISTS auto_advance           BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS buffer_seconds         INTEGER     NOT NULL DEFAULT 15;

-- RLS
ALTER TABLE public.standup_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'standup_sessions'
      AND policyname = 'authenticated_all_standup_sessions'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated_all_standup_sessions"
      ON public.standup_sessions FOR ALL TO authenticated
      USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- 站會成員個別時間設定
CREATE TABLE IF NOT EXISTS public.standup_member_durations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  standup_session_id  UUID        NOT NULL REFERENCES public.standup_sessions(id) ON DELETE CASCADE,
  member_id           TEXT        NOT NULL,
  speak_duration      INTEGER     NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(standup_session_id, member_id)
);

CREATE INDEX IF NOT EXISTS idx_standup_member_durations_session
  ON public.standup_member_durations(standup_session_id);

ALTER TABLE public.standup_member_durations ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE tablename = 'standup_member_durations'
      AND policyname = 'authenticated_all_standup_member_durations'
  ) THEN
    EXECUTE 'CREATE POLICY "authenticated_all_standup_member_durations"
      ON public.standup_member_durations FOR ALL TO authenticated
      USING (true) WITH CHECK (true)';
  END IF;
END $$;
