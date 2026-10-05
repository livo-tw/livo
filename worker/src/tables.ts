// Table metadata registry — one entry per D1 table (see schema.sql).
// Consumed by db.ts: allowlisting, boolean/json wire coercion, id and
// created_at/updated_at defaults, and upsert onConflict validation.
//
// Conventions:
//   pk          — primary key column (single-col everywhere).
//   uniques     — composite/secondary unique keys valid as onConflict targets.
//   clientAccess 'none' — table can never be touched via /api/query
//                 (orders + auth tables are server-only).
//   boolCols    — stored INTEGER 0/1, exposed as JSON true/false.
//   jsonCols    — stored TEXT JSON, exposed parsed.
//   autoId      — Postgres had a uuid/expression PK default; db.ts fills
//                 crypto.randomUUID() when id is absent on insert.
//   autoNowCols — Postgres had now()/to_char defaults; db.ts fills ISO now()
//                 when absent on insert.
//   write       — server-side permission floor per mutation op (enforced in
//                 db.ts runQuery, roles member < admin < super_admin).
//                 'own' rules need ownerCol. REQUIRED on every
//                 clientAccess:'full' table — a missing spec falls back to
//                 admin/admin/admin (secure by default).

import type { TableRegistry } from './meta';

export const TABLES: TableRegistry = {
  kb_publications: { pk:'id', clientAccess:'none' },
  kb_source_links: { pk:'id', clientAccess:'none' },
  kb_work_receipts: { pk:'id', clientAccess:'none' },
  kb_work_events: { pk:'id', clientAccess:'none' },
  kb_work_contexts: { pk:'id', clientAccess:'none' },
  kb_work_clock: { pk:'workspace_id', clientAccess:'none' },
  kb_navigation_preferences: { pk: 'member_id', clientAccess: 'none', jsonCols: ['preferences'] },
  kb_source_snapshots: { pk: 'id', clientAccess: 'none', jsonCols: ['provenance'] },
  kb_checklist_items: { pk: 'id', clientAccess: 'none', boolCols: ['is_done'] },
  kb_work_links: { pk: 'id', clientAccess: 'none' },
  kb_workflow_commands: { pk: 'id', clientAccess: 'none', jsonCols: ['result_json'] },
  knowledge_import_policy: { pk: 'workspace_id', clientAccess: 'none', jsonCols: ['data'] },
  knowledge_import_jobs: { pk: 'id', clientAccess: 'none', jsonCols: ['data'] },
  knowledge_import_files: { pk: 'file_key', clientAccess: 'none' },
  knowledge_import_usage_reconciliations: { pk: 'workspace_id', clientAccess: 'none', boolCols: ['complete'] },
  knowledge_import_maintenance_state: { pk: 'id', clientAccess: 'none', jsonCols: ['data'] },
  knowledge_import_sources: { pk: 'id', clientAccess: 'none', jsonCols: ['original', 'assets'] },
  // QA's guarded command API owns these tables. Query cannot bypass workflow/feature gates.
  qa_issues: { pk:'id', clientAccess:'none', jsonCols:['data'] },
  qa_commands: { pk:'id', clientAccess:'none', jsonCols:['issue_data','result_json'] },
  qa_comments: { pk:'id', clientAccess:'none' },
  qa_events: { pk:'id', clientAccess:'none' },
  qa_attachments: { pk:'id', clientAccess:'none' },
  qa_upload_sessions: { pk:'id', clientAccess:'none' },
  qa_upload_parts: { pk:'upload_id', clientAccess:'none' },
  qa_slack_links: { pk:'id', clientAccess:'none' },
  qa_slack_receipts: { pk:'id', clientAccess:'none' },
  qa_slack_inbox: { pk:'id', clientAccess:'none' },
  qa_project_coordination: { pk:'id', clientAccess:'none' },
  qa_coordination_commands: { pk:'id', clientAccess:'none', jsonCols:['response'] },
  qa_restore_batches: { pk:'id', clientAccess:'none' },
  release_batches: { pk:'id', clientAccess:'none', jsonCols:['data'] },
  release_commands: { pk:'id', clientAccess:'none', jsonCols:['command','data','result_json'] },
  release_events: { pk:'id', clientAccess:'none' },
  release_batch_projects: { pk:'batch_id', clientAccess:'none' },
  release_batch_tasks: { pk:'batch_id', clientAccess:'none' },
  release_outbox: { pk:'id', clientAccess:'none' },
  release_slack_links: { pk:'id', clientAccess:'none' },
  release_publications: { pk:'batch_id', clientAccess:'none' },
  // Mutations additionally pass the knowledge-base row/column guards in db.ts.
  kb_pages: {
    pk: 'id', clientAccess: 'full', boolCols: ['is_archived', 'admin_only'],
    jsonCols: ['access_policy','document_metadata'],
    autoId: true, autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'all', update: 'all', delete: 'own', ownerCol: 'created_by' },
  },
  kb_revisions: {
    pk: 'id', clientAccess: 'full',
    jsonCols: ['document_metadata'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },
  kb_attachments: {
    pk: 'id', clientAccess: 'full', autoId: true, autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'none', delete: 'all' },
  },
  kb_comments: {
    pk: 'id', clientAccess: 'full', autoId: true, autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'all', update: 'all', delete: 'all' },
  },
  // ── Auth (server-only) ───────────────────────────────────────────────────
  auth_users: {
    pk: 'id',
    uniques: [['email']],
    clientAccess: 'none',
    boolCols: ['banned'],
    autoNowCols: ['created_at'],
  },
  auth_refresh_tokens: {
    pk: 'token_hash',
    clientAccess: 'none',
    autoNowCols: ['created_at'],
  },
  // Login throttle (auth.ts). No workspace_id on purpose — see schema.sql.
  auth_login_reservations: { pk: 'id', clientAccess: 'none' },
  auth_login_attempts: {
    pk: 'key',
    clientAccess: 'none',
  },

  // ── Core team / board ────────────────────────────────────────────────────
  members: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_active', 'is_qa_admin'],
    // update is governed by the members SPECIAL rule in db.ts (runs before
    // the generic rules, columns in memberProfile.ts): super_admin
    // unrestricted; admin limited to {theme, auth_id, sort_order}; member
    // limited to own row + {theme, auth_id}; everyone may set their own
    // {avatar, color}.
    // insert/delete stay server-only (manage-member function).
    write: { insert: 'none', update: 'all', delete: 'none' },
  },
  profiles: {
    pk: 'id',
    clientAccess: 'full',
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },
  product_lines: {
    pk: 'id',
    clientAccess: 'full',
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  projects: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_archived'],
    write: { insert: 'all', update: 'admin', delete: 'super' },
  },
  statuses: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_done', 'auto_start', 'auto_done'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  sprints: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_active'],
    autoId: true,
    autoNowCols: ['started_at'],
    write: { insert: 'all', update: 'all', delete: 'none' },
  },
  tasks: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['requires_approval'],
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'all', delete: 'admin' },
  },
  task_reminder_preferences: { pk: 'id', clientAccess: 'full', write: { insert: 'none', update: 'none', delete: 'none' } },
  task_deadline_history: { pk: 'id', clientAccess: 'full', write: { insert: 'none', update: 'none', delete: 'none' } },
  task_deployments: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    write: { insert: 'all', update: 'all', delete: 'all' },
  },
  task_specs: {
    pk: 'id',
    uniques: [['task_id']],
    clientAccess: 'full',
    write: { insert: 'all', update: 'all', delete: 'all' },
  },
  task_work_contexts: { pk: 'id', clientAccess: 'none' },
  task_work_receipts: { pk: 'id', clientAccess: 'none' },
  task_work_internal_versions: { pk: 'row_id', clientAccess: 'none' },
  task_work_events: { pk: 'id', clientAccess: 'full', jsonCols: ['before_value','after_value'], write: { insert: 'none', update: 'none', delete: 'none' } },
  task_checks: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_done'],
    write: { insert: 'all', update: 'all', delete: 'all' },
  },
  task_todos: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_done'],
    write: { insert: 'all', update: 'all', delete: 'all' },
  },
  comments: {
    pk: 'id',
    clientAccess: 'full',
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'own', delete: 'own', ownerCol: 'user_id' },
  },
  status_logs: {
    pk: 'id',
    clientAccess: 'full',
    autoNowCols: ['changed_at'],
    write: { insert: 'all', update: 'none', delete: 'super' },
  },
  notifications: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_read'],
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'own', delete: 'super', ownerCol: 'recipient_id' },
  },
  member_manuals: {
    pk: 'id',
    uniques: [['member_id']],
    clientAccess: 'full',
    jsonCols: ['custom_fields'],
    autoId: true,
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'member_id' },
  },

  // ── Tags ─────────────────────────────────────────────────────────────────
  tags: {
    pk: 'id',
    clientAccess: 'full',
    write: { insert: 'all', update: 'none', delete: 'all' },
  },
  task_tags: {
    pk: 'id',
    clientAccess: 'full',
    write: { insert: 'all', update: 'none', delete: 'all' },
  },

  // ── Backups ──────────────────────────────────────────────────────────────
  backup_settings: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['enabled', 'dm_notify_enabled'],
    jsonCols: ['task_notify_types'],
    autoId: true,
    autoNowCols: ['updated_at'],
    write: { insert: 'super', update: 'super', delete: 'none' },
  },
  backup_history: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'none', update: 'none', delete: 'super' },
  },

  // ── Attachments / user prefs / logs ──────────────────────────────────────
  task_attachments: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'none', delete: 'all' },
  },
  user_column_configs: {
    pk: 'id',
    uniques: [['member_id', 'view_key']],
    clientAccess: 'full',
    jsonCols: ['visible_keys'],
    autoId: true,
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'member_id' },
  },
  activity_logs: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'none', delete: 'super' },
  },
  field_locks: {
    pk: 'lock_key',
    clientAccess: 'full', // reads need member JWT; ALL writes go through rpc.ts lock fns
    write: { insert: 'none', update: 'none', delete: 'none' },
  },

  // ── Settings stores ──────────────────────────────────────────────────────
  // Physical PK is (workspace_id, key); pk stays the logical 'key' — db.ts
  // injects the workspace filter and extends conflict targets (wsConflict).
  system_settings: {
    pk: 'key',
    clientAccess: 'full',
    jsonCols: ['value'],
    autoNowCols: ['updated_at'],
    wsConflict: true,
    wsPk: true, // physical PRIMARY KEY (workspace_id, key)
    write: { insert: 'admin', update: 'admin', delete: 'none' },
  },
  team_settings: {
    pk: 'key',
    clientAccess: 'full',
    jsonCols: ['value'],
    autoNowCols: ['updated_at'],
    wsConflict: true,
    wsPk: true, // physical PRIMARY KEY (workspace_id, key)
    write: { insert: 'admin', update: 'admin', delete: 'none' },
  },

  // ── Slack prefs / auto-reports ───────────────────────────────────────────
  user_notification_preferences: {
    pk: 'user_id',
    clientAccess: 'full',
    boolCols: ['enabled', 'include_assigned', 'include_review', 'email_notify_enabled'],
    jsonCols: ['email_notify_types'],
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'user_id' },
  },
  // 時間追蹤：成員記自己的工時（admin+ 可改任何人）。
  time_entries: {
    pk: 'id',
    clientAccess: 'full',
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'own', ownerCol: 'member_id' },
  },
  user_report_configs: {
    pk: 'id',
    uniques: [['user_id', 'report_type']],
    clientAccess: 'full',
    boolCols: ['enabled'],
    jsonCols: ['scope_project_ids'],
    autoId: true, // PG used a 'urc_<epoch>_<rand>' expression default; randomUUID is fine
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'user_id' },
  },

  // ── Orders (server-only; payments.ts writes directly) ───────────────────
  orders: {
    pk: 'id',
    uniques: [['merchant_trade_no']],
    clientAccess: 'none',
    autoId: true,
    autoNowCols: ['created_at'],
  },

  // ── Custom fields ────────────────────────────────────────────────────────
  custom_fields: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_required'],
    jsonCols: ['options'],
    autoNowCols: ['created_at'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  task_custom_field_values: {
    pk: 'id',
    uniques: [['task_id', 'field_id']],
    clientAccess: 'full',
    boolCols: ['value_boolean'],
    autoNowCols: ['updated_at'],
    write: { insert: 'all', update: 'all', delete: 'none' },
  },

  // ── Dependencies / templates ─────────────────────────────────────────────
  task_dependencies: {
    pk: 'id',
    uniques: [['task_id', 'depends_on_task_id']],
    clientAccess: 'full',
    autoId: true, // PG used a 'td_<epoch>_<rand>' expression default
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'none', delete: 'all' },
  },
  task_templates: {
    pk: 'id',
    clientAccess: 'full',
    jsonCols: ['default_tag_ids', 'default_check_items', 'default_todo_items'],
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },

  // ── Work reports / board prefs / transition rules ────────────────────────
  work_reports: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_edited'],
    autoId: true,
    autoNowCols: ['generated_at', 'updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'user_id' },
  },
  user_board_prefs: {
    pk: 'user_id',
    clientAccess: 'full',
    jsonCols: ['card_fields', 'custom_card_fields'],
    autoNowCols: ['updated_at'],
    write: { insert: 'own', update: 'own', delete: 'none', ownerCol: 'user_id' },
  },
  status_transition_rules: {
    pk: 'id',
    uniques: [['target_status_id', 'required_status_id']],
    clientAccess: 'full',
    autoId: true, // PG used a 'str_<rand>' expression default
    autoNowCols: ['created_at'],
    write: { insert: 'admin', update: 'none', delete: 'admin' },
  },

  // ── Approval workflow ────────────────────────────────────────────────────
  approval_rules: {
    pk: 'id',
    uniques: [['project_id', 'from_status', 'to_status']],
    clientAccess: 'full',
    boolCols: ['is_active'],
    autoId: true,
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  approval_rule_steps: {
    pk: 'id',
    uniques: [['rule_id', 'step_order']],
    clientAccess: 'full',
    boolCols: ['allow_delegate'],
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  approval_requests: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    jsonCols: ['steps_snapshot','rule_snapshot'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },
  approval_actions: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['acted_at'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },
  approval_command_contexts: { pk: 'id', clientAccess: 'none' },
  approval_command_receipts: { pk: 'id', clientAccess: 'none' },
  approval_events: { pk: 'id', clientAccess: 'none' },
  approval_delivery_outbox: { pk: 'id', clientAccess: 'none' },
  approval_delivery_threads: { pk: 'task_id', clientAccess: 'none' },

  // ── External integrations ────────────────────────────────────────────────
  external_account_bindings: {
    pk: 'id',
    uniques: [['platform', 'platform_user_id', 'platform_team_id']],
    clientAccess: 'full',
    boolCols: ['is_verified'],
    autoId: true,
    autoNowCols: ['bound_at'],
    write: { insert: 'own', update: 'own', delete: 'own', ownerCol: 'member_id' },
  },
  // Server-only: changed through the livo_slack_link_set RPC for the caller alone.
  slack_link_preferences: { pk: 'member_id', clientAccess: 'none' },
  external_action_logs: {
    pk: 'id',
    clientAccess: 'full',
    jsonCols: ['action_payload'],
    autoId: true,
    autoNowCols: ['acted_at'],
    write: { insert: 'own', update: 'none', delete: 'none', ownerCol: 'member_id' },
  },
  slack_thread_mappings: {
    pk: 'id',
    uniques: [['slack_channel_id', 'slack_thread_ts']],
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },
  interaction_tokens: {
    pk: 'id',
    uniques: [['token_hash']],
    clientAccess: 'none', // single-use action tokens; PG blocked client SELECT/UPDATE/DELETE — not exposed via /api/query
    boolCols: ['is_used'],
    autoId: true,
    autoNowCols: ['created_at'],
  },

  // ── Report sending ───────────────────────────────────────────────────────
  report_send_targets: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_enabled'],
    jsonCols: ['channel_config'],
    autoId: true,
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'all', update: 'admin', delete: 'admin' },
  },
  report_send_logs: {
    pk: 'id',
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['sent_at'],
    write: { insert: 'all', update: 'all', delete: 'none' },
  },

  // ── Smart notifications ──────────────────────────────────────────────────
  notification_templates: {
    pk: 'id',
    uniques: [['name']], // physical index is (workspace_id, name) — wsConflict extends it
    clientAccess: 'full',
    boolCols: ['is_default'],
    autoId: true,
    autoNowCols: ['created_at', 'updated_at'],
    wsConflict: true,
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  notification_rules: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_enabled', 'auto_send'],
    jsonCols: ['target_channels', 'priority_overrides'],
    autoId: true,
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'admin', update: 'admin', delete: 'admin' },
  },
  notification_delivery_logs: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['was_customized'],
    autoId: true,
    autoNowCols: ['sent_at'],
    write: { insert: 'all', update: 'none', delete: 'none' },
  },
  due_date_reminders: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['is_sent'],
    autoId: true,
    autoNowCols: ['created_at', 'updated_at'],
    write: { insert: 'none', update: 'none', delete: 'none' },
  },

  // ── Standup ──────────────────────────────────────────────────────────────
  standup_sessions: {
    pk: 'id',
    clientAccess: 'full',
    boolCols: ['auto_advance'],
    autoId: true,
    autoNowCols: ['started_at', 'created_at'],
    write: { insert: 'all', update: 'all', delete: 'none' },
  },
  standup_member_durations: {
    pk: 'id',
    uniques: [['standup_session_id', 'member_id']],
    clientAccess: 'full',
    autoId: true,
    autoNowCols: ['created_at'],
    write: { insert: 'all', update: 'all', delete: 'all' },
  },

  // ── Cloud beta tenancy plane (server-only; provision/waitlist code writes
  // directly — clients must never see other tenants' rows) ─────────────────
  workspaces: {
    pk: 'id',
    clientAccess: 'none',
    autoNowCols: ['created_at'],
  },
  cloud_waitlist: {
    pk: 'email',
    clientAccess: 'none',
    autoNowCols: ['created_at'],
  },
};
