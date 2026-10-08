# Migration 执行记录

记录每个 migration 在本地 Docker 和云端 Supabase 的执行状态。
新增 migration 后，请在此更新状态。

| 文件名 | 本地 Docker | 云端 Supabase | 备注 |
|--------|:-----------:|:------------:|------|
| 20260308~20260310 (初始建表) | ✅ | ✅ | 项目初始化阶段 |
| 20260326100000_create_field_locks.sql | ✅ | ✅ | 协同编辑锁 |
| 20260327_add_required_fields_and_theme.sql | ✅ | ✅ | system_settings 表 + members.theme 字段 |
| 20260327_add_slack_notify_and_reports.sql | ✅ | ✅ | user_notification_preferences + user_report_configs 表 |
| 20260327_add_license_key.sql | ✅ | ✅ | system_settings 加 license key 支持（无新表，仅确保行存在） |
| 20260327_add_installation_id.sql | ✅ | ✅ | system_settings 加 installation_id 支持 license 绑定机制 |
| 20260328_license_pg_functions.sql | ✅ | ✅ | PG 函数：activate_license / check_license / reset_license + HMAC 验证（pgcrypto） |
| 20260331_create_orders.sql | ✅ | ✅ | ECPay 支付订单表（orders），含 RLS 启用 |
| 20260331_add_custom_fields.sql | ✅ | ⏳ | 自訂欄位：custom_fields + task_custom_field_values 表，含 RLS 和 Realtime |
| 20260331_add_task_templates.sql | ✅ | ⏳ | 任務模板：task_templates 表，含 RLS 和 Realtime |
| 20260331_add_task_dependencies.sql | ✅ | ⏳ | 任務依賴：task_dependencies 表，含 RLS、Realtime、防自依賴 CHECK |
| 20260331_add_subtasks.sql | ✅ | ⏳ | 子任務：tasks.parent_task_id 欄位，ON DELETE SET NULL，含索引 |
| 20260401_team_settings.sql | ✅ | ⏳ | team_settings 表（key/value JSONB），含 RLS；預設公告內容 |
| 20260401_add_integration_settings.sql | ✅ | ⏳ | 插入五個服務整合預設設定（Slack/Webhook/Email/GitLab/Calendar） |
| 20260401_add_work_reports.sql | ✅ | ⏳ | 工作報告：work_reports 表，支援日報/週報/月報歷史記錄 |
| 20260401_add_user_board_prefs.sql | ✅ | ⏳ | 看板卡片顯示設定：user_board_prefs 表，取代 localStorage |
| 20260401_notifications.sql | ✅ | ⏳ | notifications 表索引（表本身在 20260308185150 建立）；補充 mention/assign/comment 等通知類型文件 |
| 20260402_fix_member_data.sql | ✅ | — | 修正成員 email/名稱 + activity_logs RLS 開放 anon |
| 20260402_extend_task_templates.sql | ✅ | ⏳ | 任務模板擴展：新增 default_check_items 和 default_todo_items 欄位，支持儲存驗收標準和 To Do 清單 |
| 20260402_standup_enhancement.sql | ✅ | ⏳ | Feature 1：站會模式增強，standup_sessions + standup_entries 表 |
| 20260402_multichannel_send.sql | ✅ | ⏳ | Feature 2：多頻道發送，report_targets + report_send_logs 表 |
| 20260402_approval_workflow.sql | ✅ | ⏳ | Feature 3：主管簽核流程，approval_rules/steps/requests/actions 表 |
| 20260402_smart_notification.sql | ✅ | ⏳ | Feature 4：智能通知同步，notification_rules + notification_templates 表 |
| 20260402_bidirectional_integration.sql | ✅ | ⏳ | Feature 5：雙向通訊整合，interaction_tokens + external_messages 表 |
| 20260402_add_status_transition_rules.sql | ✅ | ⏳ | 狀態流轉規則：status_transition_rules 表 |
| 20260402_fix_dependency_template_rls.sql | ✅ | ⏳ | 修復 task_dependencies 和 task_templates 的 RLS 政策 |
| 20260402_fix_integration_settings_fk.sql | ✅ | ⏳ | 修復 integration_settings 外鍵問題 |
| 20260402_fix_notification_rls.sql | ✅ | ⏳ | 修復 notifications 表 RLS 政策 |
| 20260402_fix_storage_policies.sql | ✅ | ⏳ | 修復 storage 上傳/下載政策 |
| 20260402_fix_work_reports_user_id.sql | ✅ | ⏳ | 修復 work_reports user_id 欄位類型 |
| 20260402_fix_approval_rls.sql | ✅ | ⏳ | v42 修復：收緊 approval_actions/requests/interaction_tokens RLS |
| 20260402_smart_notification_fix_rls.sql | ❌ 跳過 | ❌ 跳過 | v43：approval_rules FK 引用 statuses(name) 但代碼存的是 status ID，已被 20260403 取代 |
| 20260403_fix_approval_member_rls.sql | ✅ | ⏳ | 修復 RLS auth.uid() vs member ID 不匹配 + current_member_id() 函數（修正 auth_id::text 轉型、跳過 notification_rules 無 created_by 列） |
| 20260403_fix_notification_tables_rls.sql | ✅ | ⏳ | 修復 notification_rules/external_bindings/action_logs RLS |
| 20260403_migrate_member_ids.sql | ✅ | ⏳ | 成員 ID 格式遷移：u-xxx → m-001~m-020，涵蓋 members 表及所有關聯表外鍵（修正 activity_logs 用 user_id、跳過 integration_settings 不存在、跳過 notification_rules 無 created_by） |
| 20260404_restore_missing_statuses.sql | ✅ | ⏳ | 補回被刪除的「完成」(s6) 和「不做了」(s7) 狀態，ON CONFLICT DO NOTHING |
| 20260404_task_requires_approval.sql | ✅ | ⏳ | 任務級簽核開關：tasks.requires_approval BOOLEAN DEFAULT false |
| 20260404_clear_stale_auth_ids.sql | ✅ | — | 清空所有 members.auth_id，讓 email 重新匹配（修正 jianhong 對應錯誤） |
| 20260404_fix_activity_logs_id_default.sql | ✅ | ⏳ | activity_logs.id 加 gen_random_uuid() 預設值，修復 INSERT 400 |
| 20260404_fix_sprints_id_default.sql | ✅ | ⏳ | sprints.id 加 gen_random_uuid() 預設值，配合移除前端 generateId |
| 20260404_approval_requests_nullable_rule.sql | ✅ | ⏳ | approval_requests.rule_id 改為 nullable，支援無規則簽核 |
| 20260404_fix_notification_templates_rls.sql | ✅ | ⏳ | 修復 notification_templates RLS（created_by vs auth.uid 不匹配）+ 確保 notification_rules 開放 |
| 20260404_fix_notifications_id_default.sql | ✅ | ⏳ | notifications.id 加 gen_random_uuid() 預設值，修復 INSERT null id |
| 20260405_insert_required_custom_fields_default.sql | ✅ | ⏳ | system_settings 插入 required_custom_fields 預設值，修復 406 錯誤 |
| 20260405_fix_notifications_task_id.sql | ✅ | ⏳ | 修復 notifications.task_id 為 NULL：從 content 解析任務編號反查 tasks.task_key 填入 |
| 20261001_api_tokens.sql | ✅ | — | 個人 API 金鑰：補齊 api_tokens（表在 20260714_features_base 已建好）、收回 anon/authenticated 權限、加索引。第一個走「資料庫更新」（schema/upgrades/）的 migration：既有安裝重跑 install.sh 套用 |

---

## 成員邀請 migration（尚未正式部署）

新增 `20261103_member_invitations.sql`：已於隔離 PostgreSQL 15.18 fixture 連跑兩次，含實際角色與並發驗證；正式 Docker 主機尚未套用。Cloud 對應 D1 schema／migration 尚未部署，本表不以隔離測試代替正式 ledger。

## v46 前端修復（無資料庫變更）

構建版本：`dist-v46`（本地版）/ `dist-v46-cloud`（雲端版）
日期：2026-04-03

### 修復項目

**Critical**
- C1: Sprint 卡片消失 — 修正 BoardView 在無活躍 Sprint 時回傳空陣列的邏輯
- C2: SprintModals 死碼 — BoardView / StandupPanel 改用共用 SprintCompleteModal / SprintStartModal
- C3: Sprint 結束不處理待辦任務 — completeSprint 新增 PendingTaskAction 參數（backlog/next-sprint/keep）
- C4: 到期通知 insert 未 await — useSideEffects.ts 加入 async IIFE + 錯誤日誌
- C5: 自動報告無後端 cron — 降級為前端提示說明

**Major**
- M1: 無法單獨啟動 Sprint — 新增獨立「開始衝刺」按鈕
- M2: 新 Sprint 自動拉入所有任務 — startSprint 改為僅接收 carryOverTaskIds
- M3: 拖曳簽核無效 — BoardView 串接 getRuleForTransition + requestApproval
- M6: 設定頁混合個人/團隊 — 拆分為 MySettingsView（個人）+ TeamSettingsView（團隊）
- M7: Date.now() 碰撞風險 — 全部改用 crypto.randomUUID()
- M8: 建立任務失敗無回滾 — useCreateTaskForm 加入 optimistic rollback

**Minor**
- m1: `(supabase as any).from()` 散落 — 集中為 fromTable() helper
- m7: 簽核 Modal 無 Escape 關閉 — 補上 keydown listener
- m8: PWA icon 路徑缺 /demo/ 前綴 — vite.config.ts 修正
- m9: Array.includes() O(n) 過濾 — 改用 Set.has() O(1)
- m11: ReportSendConfig 多餘 props — 移除未使用的 currentUserId

### v46 Hotfix（同日）

- NEW-1: 修復 ReportSendConfig `currentUserId` 未定義 — 從 useAuthContext 取 currentMemberId
- NEW-2: 移除 BoardView 未使用的 GripVertical import
- NEW-3: 全面替換 15 處 Date.now() ID 為 crypto.randomUUID()，新增 `src/lib/generateId.ts` 全局 utility
