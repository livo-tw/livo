# External QA project access (self-hosted)

A super admin manages External QA under Team Members. Each login is a separate QA identity. It has no row in the internal member directory, and no access to team introductions, standups, general tasks, knowledge, Slack, or personal API tokens. The cloud and demo clients do not show the administration panel.

## Access and onboarding

- Create with the collaborator's login email and display name. Select the allowed projects; leaving the list empty grants no projects. The screen displays a temporary password once, sends no mail and requires the collaborator to change it on first sign-in.
- In the granted projects an external QA account uses the ordinary QA state, ownership, and verification rules. Moves require both projects to be granted; attachments and command receipts are scoped to the current project. Task links show only scoped references, without opening the ordinary task detail. Existing QA role and permission checks still apply.
- Edit the project list or disable the account to revoke access. Grant changes are versioned and audited, and the service checks live authorization on each request. Disabling or removing a grant does not remove the QA history.
- An unconfirmed registration retains the GoTrue login without handing out its temporary password. Check the list and administrative evidence for that attempt before doing any repair. Do not bind an existing login or use its email as authorization.

## Upgrade and verification

1. Back up the database and storage. Build and install the frontend, gateway functions, and database migrations as a matched set. Do not turn the `task-images` bucket public when rolling back. Historical task image URLs still work for signed-in internal users through the same-origin proxy; deployments with a custom API origin should verify that path before enabling external logins. Internal Presence uses authenticated private channels.
2. Before opening a real account, use disposable synthetic projects and principals through the **actual** self-hosted HTTP gateway. Check ordinary login and first-login password change, QA create/assign/comment/verify, unauthorized project list/detail/export, project move, stale request/receipt, signed upload and download, and immediate revoke. Check the direct REST, GraphQL, Edge, Storage, and WebSocket paths with both the external and anonymous credentials; no internal payload should be returned.
3. Test a known legacy task image path with internal, external and anonymous browser sessions. Confirm internal media still opens, and that proxy/CDN caches do not serve it to the latter two. In a separate internal browser session, confirm member Presence still syncs. Use only disposable attachments for probing.
4. Verify existing board use, knowledge attachments, and Slack delivery separately; do not infer product verification from the SQL fixture. Run `node scripts/test-external-qa-postgres.mjs --run` for migration idempotence and scoped database commands.
