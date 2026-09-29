-- LIVO D1 seed — idempotent (INSERT OR IGNORE everywhere).
-- Mirrors: mockClient.ts statuses, 20260402_fix_member_data + 20260403_migrate_member_ids
-- members, migration-seeded default rows (backup_settings, system_settings,
-- team_settings, notification_templates), and Worker auth users (password: test1234).

-- ── Statuses (mockClient.ts:72-80) ──────────────────────────────────────────
INSERT OR IGNORE INTO statuses (id, name, color, sort_order, is_done, auto_start, auto_done) VALUES
  ('s1', '待辦',       '#6B778C', 1, 0, 0, 0),
  ('s2', '正在進行',   '#0065FF', 2, 0, 1, 0),
  ('s3', '待驗收',     '#FF8B00', 3, 0, 0, 0),
  ('s4', '待討論確認', '#6554C0', 4, 0, 0, 0),
  ('s5', '等待部署',   '#00B8D9', 5, 0, 0, 0),
  ('s6', '完成',       '#36B37E', 6, 1, 0, 1),
  ('s7', '不做了',     '#97A0AF', 7, 1, 0, 1);

-- ── Auth users (PBKDF2-SHA256, 100k iterations, password: test1234) ─────────
INSERT OR IGNORE INTO auth_users (id, email, password_hash, banned) VALUES
  ('auth-m-001', 'jianhong@livo.test', 'pbkdf2$100000$Am/UYrphX0+ipFAP5V4gXA==$h3N5aQjc0nmsZfle0mGUvSkGEm08mszgWxJiKgaVCx4=', 0),
  ('auth-m-002', 'yaqi@livo.test',     'pbkdf2$100000$ZOTm/Cg9EVRaX4x72K9pjA==$JY/9NFu3p+Y982bEE2c11nwxWXWumIbclsSOtED6w8M=', 0),
  ('auth-m-003', 'jiarong@livo.test',  'pbkdf2$100000$CfhvTChxP7iICvYWLl4mmw==$k0hLztOwBWKcHQ2ED4F7gHMfeZTjpDiN+bnKHf+XnqQ=', 0),
  ('auth-m-004', 'xinyi@livo.test',    'pbkdf2$100000$9wT48AheWoKfqV22sKCNNg==$CiVpueC+6w+DxWLCZu7jj104k+3sgVIyzNrE8bCYIqU=', 0),
  ('auth-m-005', 'jingru@livo.test',   'pbkdf2$100000$VNEOAiT7AgLcNrpss0G87Q==$hLtQrUnousCLWnMu8vYtGOPDPXmJMGHHBBtC0CSr+54=', 0),
  ('auth-m-006', 'yuhan@livo.test',    'pbkdf2$100000$Bm9TilBsta80n0ayuo2P0Q==$/Nw0aFrHpP1Ec4fHe+88VRJQx20XaqDHq1B3wIdUUoA=', 0),
  ('auth-m-007', 'wenjie@livo.test',   'pbkdf2$100000$42R/++pqg2vX1S58CmBXvA==$1A9aiZrvTWF99+f1OoBvllynX9zhRBO9Anc2ODQr434=', 0),
  ('auth-m-008', 'zhihao@livo.test',   'pbkdf2$100000$iFhWv9cpGpLlIMKSHG1hXQ==$FvJ5TrHtMtJG/uAUwhXOxKcdGukFCk+XqPllb2qyvPM=', 0),
  ('auth-m-009', 'mingxuan@livo.test', 'pbkdf2$100000$l+M4M8oM67Orrw400Fx3/A==$pbV/McDCsa75W5aeB5tkvNHYXVYcPOjB2x4sS4t/DCQ=', 0),
  ('auth-m-010', 'peishan@livo.test',  'pbkdf2$100000$rpZmdrb9MrEvbe90nlaTtg==$NME4D5oL20NdPXjQalwbSG3bS+azR1fwG1f0QpZa8iA=', 0),
  ('auth-m-011', 'chengen@livo.test',  'pbkdf2$100000$6BbD0frYc9yUDSuGHmTu8Q==$J6hv2UtmAthJp3nLrIAeZX1BL3VILzPNaL9qoRcwzHo=', 0),
  ('auth-m-012', 'guanyu@livo.test',   'pbkdf2$100000$Q4NGLdr36IAo6NLmlA4IXw==$y1r7u9vF26xutgnctIYEkyMuxDjkOgiarCRqkf40CBw=', 0),
  ('auth-m-013', 'jiawei@livo.test',   'pbkdf2$100000$wuIVGuCvzRYoLaOAh873uQ==$lMNzrXpaVoo66nUaakzQD26DkXVC6b5QvufFAS5Gup8=', 0),
  ('auth-m-014', 'bohan@livo.test',    'pbkdf2$100000$lRNTcjsgiei2cfbHf9DS9g==$60WG9ZHhUMq8AtobUGCjU2mDb97HjARwXXksU+a4wcs=', 0),
  ('auth-m-015', 'zonglin@livo.test',  'pbkdf2$100000$la6JPdjVGrTxFCcD5f62WA==$4lI0dSEYQOFCKKDXGiZtvUpVs6kHwFI5RpewrI+PP60=', 0),
  ('auth-m-016', 'junjie@livo.test',   'pbkdf2$100000$MpF7u9x+JGPJfH1GYK+3AA==$6CZHGS1JwzrFHHq2YOLUZm8bD0t6izd6IuxPujo1CrQ=', 0),
  ('auth-m-017', 'yiting@livo.test',   'pbkdf2$100000$NyTUfHbioD2TvbLbm2pf9A==$ImcigFDzy/7HHCHQbhDettLSxXdknv51KMc91461pWE=', 0),
  ('auth-m-018', 'jiaming@livo.test',  'pbkdf2$100000$Nr51JWAlAebvO8Mdo2lzng==$QMm6K2MC3bG59EMhzjOqUSGs7LvSuVb8yWVFlLVO/b0=', 0),
  ('auth-m-019', 'yawen@livo.test',    'pbkdf2$100000$cOgQOKw964kSVFeN/529Xw==$QIn0LmSoL7Ai7UgGE0B61Fb5kgXkoieBKAqW65N/6rs=', 0),
  ('auth-m-020', 'yanting@livo.test',  'pbkdf2$100000$+vYmuOmYliiH8tluHltehQ==$mUgWaIjx6XFC0t+n4c8IkYm81ck7dRAU0nPhe50kyN4=', 0),
  -- Dedicated super-admin account. Its member row is m-000 (below), so the
  -- member-lookup middleware resolves it as a distinct first-class identity.
  ('auth-admin', 'admin@livo.test',    'pbkdf2$100000$93T5TSOUhC4p+4FpGil5+w==$g38M1k8EQC4AGCYSZOmfm+qhrHhk3fZSI2ZIxYOYtb0=', 0);

-- ── Members (schema report §2.1; theme dark, active, auth-linked) ───────────
INSERT OR IGNORE INTO members (id, name, avatar, role, job_title, color, email, is_active, sort_order, auth_id, theme) VALUES
  ('m-000', '系統管理員', '管理', 'super_admin', 'System Admin',   '#FF5630', 'admin@livo.test',    1, -1, 'auth-admin', 'dark'),
  ('m-001', '王建宏', '建宏', 'super_admin', 'CEO / 產品總監', '#FF5630', 'jianhong@livo.test', 1, 0,  'auth-m-001', 'dark'),
  ('m-002', '陳雅琪', '雅琪', 'admin',       'PM Lead',        '#6554C0', 'yaqi@livo.test',     1, 1,  'auth-m-002', 'dark'),
  ('m-003', '林佳蓉', '佳蓉', 'admin',       'PM — 遊戲產線',  '#FF8B00', 'jiarong@livo.test',  1, 2,  'auth-m-003', 'dark'),
  ('m-004', '黃心怡', '心怡', 'admin',       'PM — 電商產線',  '#00B8D9', 'xinyi@livo.test',    1, 3,  'auth-m-004', 'dark'),
  ('m-005', '張靜如', '靜如', 'member',      'UI/UX Lead',     '#FFC400', 'jingru@livo.test',   1, 4,  'auth-m-005', 'dark'),
  ('m-006', '劉宇涵', '宇涵', 'member',      'UI Designer',    '#998DD9', 'yuhan@livo.test',    1, 5,  'auth-m-006', 'dark'),
  ('m-007', '許文傑', '文傑', 'member',      'FE Lead',        '#36B37E', 'wenjie@livo.test',   1, 6,  'auth-m-007', 'dark'),
  ('m-008', '鄭志豪', '志豪', 'member',      'FE — React',     '#4C9AFF', 'zhihao@livo.test',   1, 7,  'auth-m-008', 'dark'),
  ('m-009', '蔡明軒', '明軒', 'member',      'FE — Vue',       '#79E2F2', 'mingxuan@livo.test', 1, 8,  'auth-m-009', 'dark'),
  ('m-010', '吳佩珊', '佩珊', 'member',      'FE — Mobile',    '#B3D4FF', 'peishan@livo.test',  1, 9,  'auth-m-010', 'dark'),
  ('m-011', '李承恩', '承恩', 'member',      'BE Lead',        '#0065FF', 'chengen@livo.test',  1, 10, 'auth-m-011', 'dark'),
  ('m-012', '周冠宇', '冠宇', 'member',      'BE — Java',      '#403294', 'guanyu@livo.test',   1, 11, 'auth-m-012', 'dark'),
  ('m-013', '楊家瑋', '家瑋', 'member',      'BE — Node.js',   '#00875A', 'jiawei@livo.test',   1, 12, 'auth-m-013', 'dark'),
  ('m-014', '趙柏翰', '柏翰', 'member',      'BE — Python/ML', '#5243AA', 'bohan@livo.test',    1, 13, 'auth-m-014', 'dark'),
  ('m-015', '謝宗霖', '宗霖', 'member',      'SRE Lead',       '#172B4D', 'zonglin@livo.test',  1, 14, 'auth-m-015', 'dark'),
  ('m-016', '廖俊傑', '俊傑', 'member',      'DevOps',         '#505F79', 'junjie@livo.test',   1, 15, 'auth-m-016', 'dark'),
  ('m-017', '蘇怡婷', '怡婷', 'member',      'QA Lead',        '#FF8F73', 'yiting@livo.test',   1, 16, 'auth-m-017', 'dark'),
  ('m-018', '葉家銘', '家銘', 'member',      'QA Engineer',    '#FFAB00', 'jiaming@livo.test',  1, 17, 'auth-m-018', 'dark'),
  ('m-019', '鄧雅文', '雅文', 'member',      'Data Analyst',   '#C1C7D0', 'yawen@livo.test',    1, 18, 'auth-m-019', 'dark'),
  ('m-020', '方彥廷', '彥廷', 'member',      'Data Engineer',  '#8993A4', 'yanting@livo.test',  1, 19, 'auth-m-020', 'dark');

-- ── Backup settings (single default row, 20260309050127) ────────────────────
INSERT OR IGNORE INTO backup_settings (id, enabled, interval_days, backup_hour) VALUES
  ('bset-default', 0, 7, 3);

-- ── System settings (20260327 / 20260328 / 20260405 migrations) ─────────────
INSERT OR IGNORE INTO system_settings (key, value) VALUES
  ('required_fields', '{"title": true, "project": true, "status": false, "priority": false, "assignee": false, "reviewer": false, "dueDate": true, "startDate": false, "tags": false, "background": false, "requirement": false, "notes": false, "checks": false, "todos": false, "gitlabUrl": false, "deployments": false}'),
  ('license', '{}'),
  ('installation_id', '""'),
  ('required_custom_fields', '[]');

-- ── Team settings (20260401_team_settings + 20260401_add_integration_settings)
INSERT OR IGNORE INTO team_settings (key, value) VALUES
  ('team_announcement', '{"content": "<h2>🏢 團隊公約</h2>\n<h3>溝通原則</h3>\n<ul>\n  <li>非緊急事項請用非同步方式溝通（Slack / LIVO 留言）</li>\n  <li>緊急事項可直接電話或 @ 本人</li>\n  <li>訊息請在當天工作時間內回覆；跨時區成員 24 小時內回覆即可</li>\n</ul>\n<h3>任務管理</h3>\n<ul>\n  <li>新任務建立時請填寫負責人、截止日、優先級</li>\n  <li>狀態變更請即時更新，不要等每日站立會才同步</li>\n  <li>被 Blocked 時請立即在任務留言說明，不要靜默等待</li>\n</ul>\n<h3>會議規範</h3>\n<ul>\n  <li>會議需提前 24 小時發出邀請並附上議程</li>\n  <li>超過 30 分鐘的會議需有會議記錄</li>\n  <li>非必要出席者可改為同步會議記錄</li>\n</ul>\n<h3>程式碼規範</h3>\n<ul>\n  <li>PR 需至少一人 Code Review 才能合併</li>\n  <li>主線不允許直接 push，請走 PR 流程</li>\n  <li>上線前需通過 QA 驗收</li>\n</ul>\n<p><em>最後更新：2026-04-01</em></p>"}'),
  ('integration_slack', '{"enabled": false, "webhookUrl": "", "channel": "#general", "events": ["task_created", "status_changed", "comment_added"]}'),
  ('integration_webhook', '{"enabled": false, "url": "", "secret": "", "events": ["task_created", "status_changed", "task_completed"]}'),
  ('integration_email', '{"enabled": false, "smtpHost": "", "smtpPort": 587, "smtpUser": "", "smtpPassword": "", "fromName": "LIVO", "fromEmail": "", "events": ["task_assigned", "due_soon", "mentioned"]}'),
  ('integration_gitlab', '{"enabled": false, "url": "https://gitlab.com", "accessToken": "", "projectId": ""}'),
  ('integration_calendar', '{"enabled": false, "provider": "google", "calendarId": "", "syncDueDates": true, "syncStartDates": false}');

-- ── Default notification templates (20260402_smart_notification §6) ─────────
INSERT OR IGNORE INTO notification_templates (id, name, event_type, template_content, tone, is_default) VALUES
  ('ntpl-001', '新建任務通知', 'task_created',       '📋 新任務建立：{{task_name}}｜指派：{{assignee}}｜到期：{{due_date}}｜{{description_summary}}', 'neutral',     1),
  ('ntpl-002', '狀態變更通知', 'status_changed',     '🔄 「{{task_name}}」狀態從「{{prev_status}}」變更為「{{status}}」｜負責人：{{assignee}}',       'neutral',     1),
  ('ntpl-003', '指派變更通知', 'assignee_changed',   '👋 {{assignee}}，你被指派了新任務：「{{task_name}}」｜到期：{{due_date}}',                     'friendly',    1),
  ('ntpl-004', '到期提醒',     'due_reminder',       '⚠️ 提醒：「{{task_name}}」明天到期｜負責人：{{assignee}}',                                     'warning',     1),
  ('ntpl-005', '任務逾期警告', 'overdue',            '🚨 「{{task_name}}」已逾期 {{overdue_days}} 天！｜負責人：{{assignee}}',                       'urgent',      1),
  ('ntpl-006', '請求簽核',     'approval_requested', '⏳ 「{{task_name}}」需要你的簽核｜請盡快處理',                                                 'urgent',      1),
  ('ntpl-007', '簽核完成',     'approval_completed', '✅ 「{{task_name}}」簽核已完成｜簽核人：{{approver}}',                                         'celebration', 1),
  ('ntpl-008', '新增評論通知', 'comment_added',      '💬 「{{task_name}}」有新評論｜來自 {{reporter}}',                                              'neutral',     1),
  ('ntpl-009', '自定義通知',   'custom',             '📢 {{task_name}}',                                                                             'neutral',     1);
