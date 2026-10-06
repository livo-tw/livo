# Task responsibility and Slack compatibility routes

Assignment takes effect immediately in LIVO. An assignee or reviewer does not confirm acceptance. Assigned and reviewed tasks appear in personal work without an acknowledgement receipt.

The task sidebar keeps its normal assignee and reviewer selectors. Confirmation buttons and unconfirmed responsibility prompts have been removed. Responsibility revisions, historical acknowledgement records, command receipts and audit events remain stored.

## Slack task panel

The ordinary task panel contains the current task, status, assignee, reviewer, deadline, priority and comments, with the existing core edit and comment actions. Task content is read through the authenticated member session.

`/livo context ABC-123` opens private read-only background, requirements, notes, acceptance items, to-do items and related task sections. The active section is named explicitly and is omitted from the section navigation. Each empty section names the content that is missing. Pagination and relation reads recheck current member access; unknown or inaccessible related records stay anonymous.

`/livo work ABC-123` and historical advanced work buttons, submissions and retries are compatibility routes to a fresh private core task panel. They do not call the task-work command API. Assignment confirmation is unnecessary; advanced task planning and editing belongs in the normal LIVO interface.

## Preserved backend contracts

Canonical task-work APIs, responsibility revisions, receipt hashes, compare-and-swap checks and historical audit data remain intact for compatibility. The absence of a product control does not weaken authentication, current workspace or project checks. Actor identity is resolved from the verified session and signed Slack binding, never from a modal field or copied metadata.

Old controls refresh the actor and use the authenticated workspace detail and comment reads. A saved receipt is not permission to read a card after access changes. A closed private modal does not echo task content to a public channel.

Formal QA repair, deployment, verification, closure and handoff keep their separate domain and evidence rules. Ordinary task checklists do not create a QA verification result.

Automatic due reminders follow deadlines and responsibility; historical personal pause preferences do not suppress them. Deadline edits retain their versions, committed-deadline reasons and change history.

## Validation and delivery limits

Tests use fictional records and verify immediate personal assignment, absence of confirmation controls, current-revision edits, private read-only compatibility routes, section navigation and permission failures. Shared-code checks, backend tests, typechecks, builds and release validation precede packaging. Source tests do not establish live Slack delivery, production data correctness or a server upgrade.
