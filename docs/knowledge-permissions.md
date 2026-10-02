# Knowledge permissions

Pages have a `general` or `meeting` category and an `access_policy`. Categories organize pages; they do not grant access.

The default `{ "mode": "inherit" }` preserves existing team access. A custom policy has `view`, `edit`, and `comment` rules, each containing `roles`, `positions`, and `member_ids` arrays. Selectors within a rule are ORed. Empty rules deny. Positions match the current member `job_title` exactly. The rules of every ancestor are intersected, and edit/comment always require view. An absent ancestor, malformed policy, inactive member, or cyclic hierarchy denies access.

Neither admin nor super_admin implicitly bypasses view restrictions. Administrators who can view a page can manage its policy; changing the policy must preserve their own view grant. Reparenting requires administrator status and edit access to the destination. Comment authors can edit their own comments when they retain comment access; page editors can delete comments. `admin_only` remains an additional editing restriction.

PostgreSQL RLS and Cloudflare SQL predicates protect page lists/search/counts, revisions, comments, attachments, and edit locks. Authorization reads live membership and position data. Realtime KB events carry no content in Cloudflare; PostgreSQL uses default replica identity so deletion events cannot carry old private bodies. Clients reload authorized data after changes and periodically refresh to evict pages after revocation.

Native attachments use the private `kb-files` bucket and authenticated downloads. Knowledge paths cannot be uploaded into the public task-images bucket. Existing public attachments must be migrated before a page subtree can acquire a custom restriction: error `kb_legacy_public_attachments`. External links, including Slack files, retain their provider's sharing rules. Previously downloaded or copied content cannot be recalled by changing permissions.

Only super_admin can assign positions or administrative roles when creating accounts, manage another member's login, or change another member's login binding. Members retain normal self-linking and their own authentication flows. A super_admin can deliberately grant a position or access; this administrative authority is distinct from an implicit page read bypass.

`20261007_knowledge_permissions.sql` is an additive, repeatable upgrade. Do not roll it back after storing private records, even if the frontend must be reverted. The isolated PostgreSQL fixtures are `scripts/lib/knowledge-pg-fixture.sql` and `scripts/lib/knowledge-pg-security.sql`, relative to the application source root; never run the fixture against a real workspace database.
