# Task deadlines and automatic due reminders

LIVO keeps deadline editing, deadline provenance and automatic due reminders. Personal pause controls have been removed from the task sidebar, Slack home and Slack help. Existing preference records and deadline history remain in the database and backups; a historical pause no longer suppresses due reminders.

## User behavior

- Choose an unknown, estimated or committed deadline. Imported deadlines retain their original kind until someone explicitly chooses another kind.
- Postponing or clearing an existing committed deadline requires a reason. Downgrading it to estimated in the same operation does not remove that requirement. Setting the first deadline or moving it earlier allows an optional reason.
- Every actual date or kind change records the previous and new values, the verified actor, the supplied reason, a revision and a timestamp. Missing reasons stay null.
- The deadline field and its history remain available in the task sidebar. The former personal reminder section performs no preference read or write.
- Automatic due reminders follow the deadline and current responsibility, retain notification deduplication and ignore historical pause preferences. Assignment, review, approvals, mentions and work reports retain their own delivery rules.
- Stale deadline forms do not overwrite newer revisions. Gantt start and due date changes commit together.

Slack deadline entry:

```text
/livo deadline DEMO-123
```

Old pause, resume and reminders controls return a private deprecation notice and a route back to the card or its deadline. They do not create or update pause preferences. A closed private view never falls back to a channel message containing task data.

## API and authentication

`livo_set_task_deadline` accepts `p_task_id`, `p_expected_version`, `p_due_date`, `p_kind`, optional `p_reason` and optional Gantt fields `p_change_start`, `p_expected_started_at` and `p_started_at`. The expected start is the exact stored value. The response includes the new deadline revision; restoring a deleted card must use that revision.

Tasks carry `due_date_kind` and `due_date_version`. Transient reason and actor fields are cleared after the change; historical explanations remain in `task_deadline_history`.

Legacy reminder preference APIs, types and records remain for compatibility and restoration. Product entry points no longer create personal pauses, and delivery does not use those records as a suppression rule.

PostgreSQL functions retain caller RLS and a live unique member. Slack calls use the server-verified signed binding, team and user tuple; form metadata cannot choose an actor. D1 retains workspace predicates and repeats live member, authentication and task checks. Feature guards for other workflows remain independent.

Generic task date writes also record history and enforce committed deadline reasons. Team-required deadlines cannot be cleared. General task deletion retains its existing cascade semantics; history is not a separate retention system.

## Backup and import

Scheduled backups retain complete deadline history and legacy reminder preferences. Lightweight whole-database restore remains blocked on real backends; use the full server restoration procedure. The legacy Docker-to-D1 import preflight still refuses destructive replacement when planning evidence or positive deadline revisions exist.

Jira replacement checks planning evidence before child deletion in the same transaction or batch. Preserve the planning and approval import guards together. Removing the user interface does not remove either guard or imply that stored evidence is absent.

## Validation and release

Regression tests cover committed deadline conflicts and reasons, history scope changes, absence of pause UI and API calls, due-reminder delivery despite old preferences, deduplication and private handling of obsolete Slack controls. Shared-code checks, applicable native permission tests, typechecks, builds and release validation are required before packaging.

Released migrations remain unchanged. Local fixtures use fictional data and do not establish live Slack delivery, host acceptance or a production upgrade.
