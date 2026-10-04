# Private document imports

Knowledge and meeting pages share **Import documents**. It accepts `.docx`, UTF-8 `.md`, PDF, and explicitly allowed Notion pages through a LIVO-managed read-only integration. It does not use a user's Codex connection. Legacy Word `.doc`/`.docm` and Markdown/Notion ZIP bundles are rejected with a conversion hint.

Only the highest administrator configures the `knowledge.import` capability in Team management → Permissions. A matching system role, position, or member grants import. This does not grant page access: each read, destination preview, retry, download, and commit checks the active member and current page ACL. A Notion connection has a separate set of permitted users and an explicit page allowlist. Child pages must be explicitly selected and allowed; the importer never crawls an entire workspace.

## Private processor

The self-host stack can run `docker/knowledge-processor`, an optional service that is off by default: it sits in the compose profile `knowledge-processor` and is built and started by the installer only when `docker/.env` sets `KNOWLEDGE_PROCESSOR_ENABLED=1` (the build needs outbound Debian/PyPI access; a failed build only warns, and the import dialog then reports that the processor is not configured). It runs without host ports, host mounts or internet access. It is a non-root, read-only container with a temporary filesystem, one CPU, 768 MB memory and bounded child-process execution. Functions are connected to its internal Docker network. OCR uses local Poppler and Tesseract (`eng`, `chi_tra`, `chi_sim`); documents are not sent to public LIVO or an external OCR/model provider.

Functions require these operator settings:

| Variable | Purpose |
|---|---|
| `KNOWLEDGE_PROCESSOR_URL` | Empty means not configured. The self-host installer sets `http://knowledge-processor:8091` while the processor is enabled; cloud deployments must configure their own trusted processor endpoint. An unreachable processor fails the item with `processor_unavailable`. |
| `KNOWLEDGE_PROCESSOR_TOKEN` | Random secret of at least 32 characters, shared only by the API/functions and processor. A processor started without it stays up and answers `processor_not_configured`. |
| `KNOWLEDGE_IMPORT_SECRET` | Independent random secret of at least 32 characters for encrypting stored Notion integration tokens with AES-GCM. Keep stable across upgrades; replacing it requires reconnecting Notion. |
| `KNOWLEDGE_OCR_ENABLED` | Processor-only setting: `1` enables local OCR. Without it, scanned pages remain pending and cannot be claimed as a complete conversion. |

Time budgets nest: the processor parses one document at a time for at most 85 seconds (OCR starts new pages only during the first 40 seconds, each page at most 40 seconds; later pages stay `ocr_pending` for a retry that reuses finished pages), the caller waits at most 95 seconds, and the self-host `knowledge-import` function may run for 150 seconds. When the caller disconnects, the processor stops the parse and frees its slot.

Cloudflare Workers keep parsing work in the active HTTP request (not the 30-second post-response `waitUntil` window). A persisted job is created before processing; after a disconnected request, use My import history to recover it rather than uploading again. Abandoned processing becomes retryable after a stale lease is detected. Workers orchestrate jobs and private R2 staging; they do not run PDF/Word native processes. A missing processor is an explicit configuration error. Tokens are never returned in frontend policy reads, logs or export configuration; Notion integration secrets are stored encrypted in the server-only policy table.

## Conversion and review

Limits: 10 MB per upload/Notion selection and per processor HTTP response, 40 PDF pages, 24 retained assets, 2 MB per individual image/Notion attachment, 800,000 converted characters and a 900,000 UTF-8 byte bound on each stored body. Processor responses are read through a bounded stream before JSON parsing. DOCX ZIP expansion, entry count, paths, XML entities and executable Office parts are checked before parsing. Parser output is passive allowlisted HTML: scripts, active embeds, event attributes and external image loads are not retained. Unknown/unsupported content generates visible review warnings. Word images are retained as private source attachments; floating layout, comments, tracked changes and unsupported images require checking against the original.

Every PDF page is inspected. Text pages preserve page numbers; sparse/image pages use OCR. Confidence and low-confidence regions are provenance, not confirmed product decisions. Missing/failed OCR is `ocr_pending`/incomplete. Users may explicitly retain the available text and original as an **incomplete conversion**; the UI must not label it complete. Original historical checkboxes remain source text until a person promotes work through the existing Task/QA workflow.

Notion requests only fixed `https://api.notion.com/v1/` endpoints with API version `2025-09-03`. Page IDs and explicit connection access are validated. Rate limits have a bounded retry. Attachments are retained only from a narrow official host allowlist, without redirects, with size/type limits; other embeds are not fetched. Expired, unsupported and missing blocks are disclosed in the preview.

## Staging, versions and recovery

Private staging uses `kb-imports`, not a public attachment bucket. Generic database/storage APIs cannot read it. Previews become unreadable after 24 hours. Hourly system maintenance removes expired private staging without requiring the uploader to sign in or retain import permission. Maintenance discovers overdue job identifiers across workspaces; claims, source-reference checks, file deletion and quota updates are scoped to the identified workspace. Cloud maintenance has no member HTTP endpoint. The self-host cleanup function accepts only the service-role credential used by its scheduler.

Cleanup preserves every original or asset still referenced by a committed source, including sources created by another member. A version fence blocks old parser/commit work, and a later second sweep removes the temporary content-free tombstone and any late objects. The bounded system scan also removes legacy orphan objects only when their storage timestamp is at least 24 hours old, their job is absent, and no committed source references them; uncertain timestamps are retained. Storage failures retain the claim for a subsequent attempt; physical deletion occurs on the scheduled sweep and can be delayed by failures. The 24-hour access deadline does not depend on successful deletion. Cancelling a job attempts to remove its private preview and unreferenced files immediately without deleting pages already committed. Processing and commit jobs stopped for over three minutes can recover from recorded item results. Parser failures retry parsing and require a new preview review; commit-only failures recheck the destination and retry the commit.

Self-host orphan cleanup scans only the private `kb-imports` bucket, in batches of 100 with a persisted cursor that also advances past retained or failed objects. Both creation and update timestamps must be over 24 hours old; the storage identity, timestamps, absent job and source references are checked again immediately before deletion. Ordinary knowledge attachments are outside this scan.

In hosted workspaces, original uploads, extracted assets and private parsed payloads all count toward storage usage. Capacity is reserved atomically before storage writes and includes active QA upload reservations. Failed writes release capacity only after object deletion succeeds. A restartable system scan adopts existing import files into the usage ledger once, including historic usage already over quota; further uploads are then blocked. Keeping a committed original does not release its occupied capacity. The default self-host workspace retains its unlimited quota behavior.

Cloud jobs persist small per-item metadata in D1 and retain full converted text/page text in private R2 payloads. This allows a multi-page Notion import without serializing every page into one D1 record. Converted page bodies must fit 900,000 UTF-8 bytes; source provenance stores page number, state and confidence rather than duplicating each page's text. Size failures remain explicit and recoverable. These bounds account for D1's [2,000,000-byte row, string and BLOB limit](https://developers.cloudflare.com/d1/platform/limits/).

Commit accepts stored preview IDs, versions and mapping choices, never a client-supplied verified body. Each page, inherited/custom ACL, immutable `kb_source_snapshots` row, and source mapping is committed in one database transaction. Membership, capability revision and destination ACL/version are rechecked inside that transaction. Successful items are unique by job/item, so a response lost after commit can be retried without duplicate pages. Results show partial success by item.

A same-source duplicate in the same authorized target is offered as an existing-page source update or an intentional copy. Updating adds an immutable **source version**, preserving the edited knowledge-page body. The dialog compares the previous source, current edited page, and incoming source; reviewed changes can be applied in the existing editor. This release does not silently perform automatic block merges.

## Validation and remaining environment checks

`docker/knowledge-processor/test_parser.py` exercises actual libraries and optional HTTP tests (`PROCESSOR_TEST_URL`/`PROCESSOR_TEST_TOKEN`) including a generated mixed PDF and real Tesseract OCR. Vitest covers capability/ACL changes, expiry, server-held previews, destination version conflicts, and actual SQLite transactions. `scripts/lib/knowledge-import-pg-security.sql` belongs to the real PostgreSQL security harness and verifies idempotent migration/application and all system-role boundaries.

Synthetic test documents contain no company records. A real Notion token/workspace is deliberately not configured by tests; operator connection and live Notion acceptance still need a configured environment. This document describes implemented behavior, not a production deployment.

Parser version references: [python-docx 1.2.0](https://python-docx.readthedocs.io/en/stable/), [pypdf 6.19.0](https://pypdf.readthedocs.io/en/stable/), [markdown-it-py 4.2.0](https://pypi.org/project/markdown-it-py/4.2.0/), [Markdown HTML safety](https://markdown-it-py.readthedocs.io/en/latest/security.html), [Notion page Markdown API](https://developers.notion.com/reference/retrieve-page-markdown), [Tesseract CLI](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html).
