# QA, Slack and the shared deployment queue

Task responsibility takes effect when a member is assigned. Neither the web app nor Slack asks the assignee or reviewer to acknowledge it. Existing responsibility revisions and historical receipts remain available for audit; an obsolete acknowledgment control only opens the freshly authorized task.

## QA fields and workflow

The sidebar permits direct editing of project, state, severity, priority, fix assignee, QA owner and deadline. Metadata uses `update_fields`; state uses the existing participant-authorized `set_state`. Metadata updates preserve workflow state, fix cycles, deployment targets, verification runs and closure evidence, including on completed records. Destination projects and members must remain active and authorized. The server retains optimistic concurrency and audit events.

Repair notes, component, product build/version, deployment evidence and verification notes are optional. Empty details are stored as empty details, never as invented versions or proof. A repair still declares at least one required environment. Previous repair targets may be reused as suggestions; a discovery version must not be silently asserted as the repaired build. Environment options come from the workspace deployment environment setting.

Formal verification and closure remain distinct. Formal fixed closure requires every required target in the current fix cycle to have an actual deployment record and a passing verification. Optional QA handoff remains an advanced action and does not certify a test result. Manual state editing preserves its existing contract and never creates deployment or verification evidence.

## Slack interaction

The general task panel exposes four actions: view content, edit task, add a comment and open LIVO. Advanced task work stays in LIVO. Legacy work and acknowledgment controls safely return a current authorized task panel without repeating an obsolete write. The current content section is clearly selected, and an empty field names the missing section.

New Bug forms may specify the fix assignee and QA owner immediately. Creation and the subsequent metadata command use separate stable command IDs; a partial result must identify the saved Bug and permit a safe retry without creating another Bug. A Bug with both current active roles can proceed to repair without repeating assignment.

Bug notifications display the current human-readable state prominently, separately from the event that triggered the notice. Buttons use the current state and current actor authorization. Old controls must explain an expired assignment or an unavailable step and provide a freshly authorized route rather than leaving a loading view. Restricted records must not leak their metadata through that fallback.

Closing a processing modal does not cancel an accepted backend operation. Its completion is sent privately to the actor using the source interaction channel, with a direct-message fallback if that private receipt fails. Responsibility notifications retain their own recipient rules: the actor does not receive a second responsibility notice for a change they made themselves.

Approvals being disabled hides approval controls and associated help. Personal reminder pause controls are removed. Existing pause preferences and deadline history remain for compatibility and backup, while automatic due reminders follow the current deadline, current responsibility and normal deduplication.

## Shared deployment queue

The queue reuses original task and Bug records; requesting deployment never creates an additional task. General tasks are selected by explicitly configured existing workspace status IDs. Bug requests come from current repair targets that still need deployment. Terminal or obsolete targets must not appear as current requests. Each entry opens its original card.

The feature is off by default through `feature_toggles.deploymentQueue`. Workspace configuration uses `system_settings.deployment_queue`:

```json
{"version":1,"enabled":false,"taskStatusIds":[],"operatorMemberIds":[]}
```

Only an active super_admin may configure operators. The backend derives this narrow capability from trusted workspace settings and active membership; a client flag or a job title is insufficient. Deployment operators may record deployment, while repair, QA verification and closure retain their original authorization. Normal authorized readers can see the scoped common list. Incomplete reads display an unknown result rather than a false empty queue.

Instance-specific member IDs, status IDs and notification routes belong to instance data outside every repository. The public export contains only the reusable feature and unconfigured defaults.

## Self-host canonical links

An explicitly configured HTTPS `APP_BASE_URL` may act as the canonical page origin. Legacy page links redirect while preserving task or Bug query parameters. API requests, static resources and health checks retain their normal routes. The configured origin must be validated and must not create a redirect loop behind a reverse proxy.

## Verification boundaries

Docker/Postgres and Worker/D1 must implement the same metadata and deployment capabilities. New migrations are repeatable and preserve data. Shared-code synchronization, both typecheck paths, complete tests, all build modes, release packaging and public-export verification are required before release. Source tests do not establish successful live Slack delivery or a successful instance upgrade; those require separate live readback.
