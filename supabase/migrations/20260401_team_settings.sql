-- 20260401_team_settings.sql
-- 通用團隊設定表：公告佈告欄內容、側邊欄欄位排序等

CREATE TABLE IF NOT EXISTS team_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}',
  updated_by text REFERENCES members(id) ON DELETE SET NULL,
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE team_settings ENABLE ROW LEVEL SECURITY;

-- 所有已認證用戶可讀
CREATE POLICY "team_settings_read" ON team_settings
  FOR SELECT USING (true);

-- 所有已認證用戶可寫（應用層做角色檢查）
CREATE POLICY "team_settings_write" ON team_settings
  FOR ALL USING (true) WITH CHECK (true);

-- 預設公告內容
INSERT INTO team_settings (key, value, updated_at)
VALUES (
  'team_announcement',
  jsonb_build_object(
    'content',
    '<h2>🏢 團隊公約</h2>
<h3>溝通原則</h3>
<ul>
  <li>非緊急事項請用非同步方式溝通（Slack / LIVO 留言）</li>
  <li>緊急事項可直接電話或 @ 本人</li>
  <li>訊息請在當天工作時間內回覆；跨時區成員 24 小時內回覆即可</li>
</ul>
<h3>任務管理</h3>
<ul>
  <li>新任務建立時請填寫負責人、截止日、優先級</li>
  <li>狀態變更請即時更新，不要等每日站立會才同步</li>
  <li>被 Blocked 時請立即在任務留言說明，不要靜默等待</li>
</ul>
<h3>會議規範</h3>
<ul>
  <li>會議需提前 24 小時發出邀請並附上議程</li>
  <li>超過 30 分鐘的會議需有會議記錄</li>
  <li>非必要出席者可改為同步會議記錄</li>
</ul>
<h3>程式碼規範</h3>
<ul>
  <li>PR 需至少一人 Code Review 才能合併</li>
  <li>主線不允許直接 push，請走 PR 流程</li>
  <li>上線前需通過 QA 驗收</li>
</ul>
<p><em>最後更新：2026-04-01</em></p>'
  ),
  now()
)
ON CONFLICT (key) DO NOTHING;
