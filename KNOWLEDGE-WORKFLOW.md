# Knowledge and meeting workflows

Knowledge pages hold current rules and confirmed decisions. Meetings keep their original record alongside a separate, editable execution panel. Historical `[ ]` and `[x]` marks in source text are labelled as historical; only the execution panel changes current work.

## From decisions to execution

- Add a light checklist item when no owner or deadline is needed. Only page editors can change its state.
- Create or link a task for accountable work. Create or link a QA issue for a defect. Both destinations require their own permission checks and keep their existing workflow rules.
- Links point back to the source page and paragraph. Linked tasks and issues display their current state; editing a knowledge checklist cannot complete them.
- Unlinking removes the relationship and preserves the task or issue. Missing or inaccessible destinations reveal no title or status.
- A source snapshot records the version that informed the work. Later source imports add versions; they do not replace an editor's curated text automatically.

## Personal navigation

Parents can collapse. Favorites and pins belong to the signed-in account; a pin is also a favorite. Drag siblings within one parent, or use the keyboard and move controls. Search/filter results cannot be reordered. Reset restores the shared tree order and does not change teammates' preferences.

## Import

The highest administrator sets who may import in **Team management → Document import permission**, by role, position, or named member. Import permission does not grant access to restricted destinations or bypass ancestor page restrictions. Only the highest administrator changes job titles and the read-only Notion connection.

Use the import wizard to upload Markdown, DOCX or PDF, or select allowed Notion page links. Review extracted text and conversion warnings, select a destination and access policy, then confirm the selected items. Results show successful, failed and retryable items separately. Originals and extracted assets remain private, behind the same live page permissions.

Limits: 10 MB per source, 40 PDF pages; private staging expires after 24 hours. Scanned and mixed PDFs use local OCR and require review. Encryption, unsupported conversions and OCR failures are reported before publication. Content from documents is data and is never executed as an instruction. Notion child pages are not imported implicitly.

Self-host installation includes an internal-only `knowledge-processor` service using Poppler and Tesseract. It has no published port or host storage mounts. Installers generate `KNOWLEDGE_PROCESSOR_TOKEN` and `KNOWLEDGE_IMPORT_SECRET` once and preserve them on upgrades. Cloudflare installations configure a private processor URL/token and encryption secret themselves; unconfigured parsing remains unavailable. Never place these values or company documents in Git.

## Slack search

Enable Slack interactions and use `/livo kb keyword`, the **Search knowledge** button, or the `livo_search_knowledge` message shortcut. The shortcut pre-fills a query and waits for confirmation. Search opens a private modal containing at most five authorized page titles, scope/date and LIVO links. It sends no page body, source files, hidden result counts, channel messages or direct-message fallback. Every query and pagination action checks current membership and ancestor permissions.

Docker uses the existing Socket Mode relay. The app manifest includes the new message shortcut; update the existing app's shortcut configuration. Cloudflare accepts signed requests at `/api/functions/slack-interact/<workspaceId>` as well as the existing QA route. External source links open in a new tab.

When Slack and LIVO emails differ, only the highest administrator may map accounts. Older manual mappings need confirmation before knowledge search can use them. Email mappings remain verified against Slack membership and the active LIVO login. No changes to a real Slack installation are made by merely deploying this code.

## Verification

`node scripts/test-knowledge-postgres.mjs --run --report <path>` runs migrations twice and role/security assertions in an isolated local PostgreSQL container. It never uses a live workspace database. The normal Vitest suite includes SQLite preference/search/import checks and UI workflow tests. Processor tests use fictional files; real team content is not a test fixture.
