# External QA project access (self-hosted)

A super admin manages External QA under Team Members. Each login is a separate QA identity. It has no row in the internal member directory, and no access to team introductions, standups, general tasks, knowledge, Slack, or personal API tokens. The cloud and demo clients do not show the administration panel.

## Access and onboarding

- Create with the collaborator's login email and display name. Select the allowed projects; leaving the list empty grants no projects. Administrators can enter an initial password of at least 8 characters and at most 72 UTF-8 bytes, or leave it empty for a generated password. The screen displays the password once and requires the collaborator to change it on first sign-in.
- In the granted projects an external QA account uses the ordinary QA state, ownership, and verification rules. Moves require both projects to be granted; attachments and command receipts are scoped to the current project. Task links show only scoped references, without opening the ordinary task detail. Existing QA role and permission checks still apply.
- For internal users, the reporter's account type does not change a bug's fields, history, attachments, notifications, or available actions. With the same internal role, assignment, participation and issue state, externally and internally reported bugs use the same permissions and workflow. Preserve the actual reporter account and include authorized external identities in QA reporter/owner filters and historical labels. These display identities do not become internal members or grant new access to external accounts.
- Edit the project list or disable the account to revoke access. Grant changes are versioned and audited, and the service checks live authorization on each request. Disabling or removing a grant does not remove the QA history.
- Registration requests have stable IDs. A protected registration record and a server-owned nonce bind a newly created login to that request. After a failed or lost response, reload the account list and reissue an initial password for the matching pending account. Recovery is available only before the first password change and checks the current revision. Existing unrelated logins cannot be adopted by matching their email.
- The server owns the first-password requirement. A real password change clears it. Updating profile metadata cannot clear it. Existing external logins without authoritative onboarding evidence must complete a fresh password change after upgrading, while retaining their current password until they do so.
- Creating or recovering an external login requires an interactive super-admin session. Personal API keys cannot receive a new external login credential.
- PostgreSQL change subscriptions require a live internal member. External accounts cannot subscribe to internal task deletion identifiers. Revoking internal membership also removes existing PostgreSQL change subscriptions.
- Hourly service maintenance cleans expired QA upload reservations after a five-minute settling period, even when the QA feature is off. Active uploads and committed attachments are retained. Failed object deletion retains the reservation for retry, and a 24-hour tombstone protects against late upload completion. Cloud cleanup follows existing workspace enumeration and scopes every reservation query to its workspace.

## Upgrade and verification

1. Back up the database and storage. Build and install the frontend, gateway functions, and database migrations as a matched set. Do not turn the `task-images` bucket public when rolling back. Historical task image URLs still work for signed-in internal users through the same-origin proxy; deployments with a custom API origin should verify that path before enabling external logins. Internal Presence uses authenticated private channels.
2. Before opening a real account, use disposable synthetic projects and principals through the **actual** self-hosted HTTP gateway. Check ordinary login and first-login password change, QA create/assign/comment/verify, unauthorized project list/detail/export, project move, stale request/receipt, signed upload and download, and immediate revoke. Check the direct REST, GraphQL, Edge, Storage, and WebSocket paths with both the external and anonymous credentials; no internal payload should be returned.
3. Test a known legacy task image path with internal, external and anonymous browser sessions. Confirm internal media still opens, and that proxy/CDN caches do not serve it to the latter two. In a separate internal browser session, confirm member Presence still syncs. Use only disposable attachments for probing.
4. Verify existing board use, knowledge attachments, and Slack delivery separately; do not infer product verification from the SQL fixture. Run `node scripts/test-external-qa-postgres.mjs --run` for migration idempotence and scoped database commands.

The self-hosted first-password gate consumes GoTrue's server-written password audit event in the same database transaction as the password update. Keep GOTRUE_AUDIT_LOG_DISABLE_POSTGRES=false as pinned by the shipped Compose configuration. Disabling PostgreSQL auth audit logging leaves the gate closed. A hash re-encryption or a profile metadata update alone cannot complete onboarding.

## Assignment directory

Within a granted project, external QA may select any active internal member as
repair assignee, including members who have not participated in that project's
QA. The service returns only id, display name, avatar, color and active status;
its legacy jobTitle field is empty. Project candidate responses also carry a
server-derived isExternal display classification; no ID prefix or caller flag
is accepted as authority to assign an RD. It does not open the internal members table,
email, login, Slack identity, role, or other projects. With no project grants the
profile contains no directory. Each request checks the current grant again.

QA presentation preserves supplied avatars, colors and titles. Missing avatars
use the first Unicode character of the display name and the standard fallback
color. Only a positive server `isExternal: true` supplies the display subtitle
`QA` when a title is absent; unknown identity kinds and internal members do not
receive that subtitle. Raw member/actor job titles and knowledge permissions
stay unchanged. List/detail `memberProfiles` metadata is limited to participants
of the authorized page or issue, including historical inactive authors; it is
not an assignment directory. Paging and scope changes discard stale profiles.

New repair assignments must be active internal members. External QA accounts
are separate QA owners and handoff candidates only within their granted project;
they are not offered as internal RD. The database locks and rechecks a selected
new RD at commit, so a stale list cannot assign a deactivated member. Visible QA
history retains inactive participants' display names without offering them as
new choices. An assigned internal RD uses the existing member QA read/start-fix
rules; assigning a bug does not grant broader project access.

The same directory feeds create, field editing, triage and handoff. Verification
records the signed-in eligible QA owner, not a client-supplied tester identity.
Deploy the new frontend and 20261116_external_qa_assignment_directory.sql together;
regress new cross-project internal assignment, unauthorized/revoked grants,
inactive candidates, external/internal separation and minimal directory fields.
