-- Per-user kanban board display preferences
-- Stores card field visibility and subtask display mode so prefs sync across devices

CREATE TABLE IF NOT EXISTS user_board_prefs (
  user_id       TEXT        NOT NULL PRIMARY KEY,
  card_fields   JSONB       NOT NULL DEFAULT '{}',
  custom_card_fields JSONB  NOT NULL DEFAULT '{}',
  subtask_mode  TEXT        NOT NULL DEFAULT 'independent'
                            CHECK (subtask_mode IN ('independent', 'nested')),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE user_board_prefs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "board_prefs_own" ON user_board_prefs
  FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE user_board_prefs IS '看板卡片欄位顯示設定，每位成員一筆，替換 localStorage 以支援跨裝置同步';
