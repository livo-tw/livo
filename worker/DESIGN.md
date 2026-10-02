# LIVO Cloudflare Backend — Design (Supabase → CF full migration)

Status: implementation contract. Everything here is binding for module implementers.
Wire types live in `src/protocol.ts` (imported by both the Worker and the frontend shim).

## Topology

- **Worker `livo-api`** on custom domain `api.livo-tw.com` (zone already on this account;
  the Pages project `livo` keeps serving livo-tw.com + /demo unchanged).
- **D1 `livo-db`** (created with `npx wrangler d1 create livo-db`) replaces Postgres.
- **Durable Object `RealtimeHub`** (single instance, name `"hub"`, non-hibernating,
  in-memory state) replaces Supabase Realtime (postgres_changes + presence).
- **R2 `livo-attachments`** replaces Storage buckets. Key prefix = old bucket name:
  `task-images/...` and `backups/...` so existing `storage_path` values keep working.
- **Auth**: Worker-issued HS256 JWTs (secret `JWT_SECRET`). Access 1 h, refresh 30 d
  rotating, refresh tokens stored hashed (SHA-256) in D1 `auth_refresh_tokens`.
- Frontend talks to the Worker through `src/integrations/backend/cfClient.ts`,
  a drop-in for the supabase-js subset the app uses (mockClient.ts is the interface
  reference). Selection in `client.ts`: `IS_DEMO_PRO` → mock; else `VITE_API_URL` set
  → cfClient; else legacy supabase client (removed at final cleanup).

## Routes (all under the Worker; CORS: origins from `ALLOWED_ORIGINS`, headers
`Authorization, Content-Type`, credentials not used — Bearer tokens only)

| Route | Auth | Module |
|---|---|---|
| `POST /api/query` | member JWT | `db.ts` |
| `POST /api/auth/login` `refresh` `logout` | public / refresh token | `auth.ts` |
| `GET /api/auth/user` | JWT | `auth.ts` |
| `POST /api/rpc/:fn` | member JWT (locks/license); `check_license` also allows anon | `rpc.ts` |
| `POST /api/functions/:name` | per-function (see below) | `functions/*.ts` |
| `GET/POST /api/functions/og-task` | public | `functions/ogTask.ts` |
| `POST /api/functions/create-order` | public | `functions/payments.ts` |
| `POST /api/functions/payment-callback` | public (ECPay S2S, CheckMacValue-verified) | `functions/payments.ts` |
| `POST /api/functions/payment-result` | public (browser form post) | `functions/payments.ts` |
| `GET /api/functions/download-source` | public (token query) | `functions/payments.ts` |
| `POST /api/storage/:bucket/*` (upload, raw body, `x-file-name` optional) | member JWT | `storage.ts` |
| `GET /api/storage/task-images/*` | **public** (immutable cache headers) | `storage.ts` |
| `GET /api/storage/backups/*` | member JWT | `storage.ts` |
| `POST /api/storage/:bucket/remove` `{paths:[]}` | member JWT | `storage.ts` |
| `GET /api/realtime` (WebSocket, `?token=` JWT) | JWT | `realtime.ts` (DO) |
| `GET /api/health` | public | `index.ts` |

Compat aliases (old hardcoded URLs in the app are also being fixed, but cheap to keep):
`POST /functions/v1/:name` → same as `/api/functions/:name`;
`POST /rest/v1/rpc/:fn` → same as `/api/rpc/:fn` (usePresenceLock keepalive beacons).

## D1 conventions (CRITICAL correctness rules)

Postgres → SQLite translation used by `schema.sql` and enforced by `db.ts`:

- ids: TEXT (uuid strings). DB-generated ids for `sprints, notifications, activity_logs,
  work_reports, backup_history, orders, approval_*, standup_*, notification_*, report_*,
  external_*, interaction_tokens, due_date_reminders, field_locks, task_attachments,
  custom **uuid default** → generated in `db.ts` on insert when `id` absent
  (crypto.randomUUID()), NOT via SQL default — so RETURNING always has it.
- `timestamptz` → TEXT ISO-8601 UTC (`new Date().toISOString()`). `now()` defaults are
  applied in `db.ts` (`created_at`, `updated_at` etc. per table registry), not SQL.
- `boolean` → INTEGER 0/1 in storage, **BUT the wire format must be JSON true/false**.
  The frontend uses `row.is_active !== false` patterns that break on 0/1.
  → `tables.ts` registry lists boolean columns per table; `db.ts` coerces both directions.
- `jsonb` / `text[]` / `jsonb[]` → TEXT holding JSON. Registry lists json columns;
  `db.ts` parses on read, stringifies on write. (Frontend mappers tolerate JSON strings
  only for `tag_ids`, `options`, `default_tag_ids` — everything else expects real
  arrays/objects, e.g. `system_settings.value`, `task_notify_types`,
  `default_check_items`.)
- enums → TEXT + CHECK constraints.
- FKs: declare with `ON DELETE CASCADE` where Postgres had it. `PRAGMA foreign_keys` is
  ON in D1. **Exception**: `notifications.task_id` gets NO FK (app inserts `''`).
- `numeric`/`bigint` → INTEGER/REAL as appropriate.

## `db.ts` — the query engine

Input: `QueryRequest` (protocol.ts). Output: `QueryResponse`.

- Table allowlist from `tables.ts` — unknown table → error. `orders`,
  `auth_users`, `auth_refresh_tokens`, `auth_login_attempts` are NOT client-queryable.
- Filters map 1:1 to SQL (`eq→=`, `neq→!=`, `in→IN (...)`, `is null`, `not.is null→IS NOT NULL`,
  `gt/gte/lt/lte`, `like/ilike→LIKE` (NOCASE for ilike)). `or` receives the PostgREST
  string; ONLY the grammar `col.eq.V,col.is.null` (comma-joined simple conditions with
  ops eq|neq|is|gt|gte|lt|lte) must parse — that covers the single call site
  (`project_id.eq.X,project_id.is.null`) with a little headroom.
- Boolean filter values: accept JSON true/false and compare against 1/0.
- `select` string: `*` or flat column list (trim spaces). No embeds exist app-wide.
- `order` (multi), `limit`, `offset`. `single`: 0 rows → error `{message:'No rows found',
  code:'PGRST116'}` with data null; >1 rows → error; `maybeSingle`: data = row|null, no error.
- `count: 'exact'` + `head:true` → `SELECT COUNT(*)`, data null, count set.
  `count` without head → run both (rows + count).
- insert: single object or array. Fill id/created_at defaults per registry. Multi-row →
  one statement with multiple VALUES tuples; **chunk at ≤80 params/statement** via
  `batch()` (atomic). If `returning` requested (`.select()` after insert) → RETURNING *.
- update: `UPDATE ... SET ... WHERE filters RETURNING *` (returning always — cheap, needed
  for change events + optimistic-lock `.select().single()` pattern: 0 rows updated +
  single → PGRST116 error, data null — the approval workflow relies on this).
- delete: `DELETE ... WHERE filters RETURNING *` (old rows feed change events).
- upsert: `INSERT ... ON CONFLICT(cols) DO UPDATE SET <every provided col>=excluded.<col>`.
  Conflict target: explicit `onConflict` or the table's PK from registry. Multi-row same
  chunking.
- **Change events**: after any successful write, build `ChangeEvent[]`
  (INSERT→new=row,old=null; UPDATE→new=row,old={id:...}; DELETE→new=null,old=full row)
  and `ctx.waitUntil(hub.fetch('/notify', events))`. Row payloads go through the same
  boolean/json wire coercion. DELETE old rows must include at least `id` and `task_id`
  when present (full row satisfies this).
- Errors: `{message: string}` — optionally `code:'23505'` on UNIQUE violation (frontend
  reads only `.message`; keep messages human-useful).
- **Authorization** (replaces RLS — current RLS is permissive `USING(true)` almost
  everywhere; parity model):
  - every /api/query call requires a valid JWT resolving to an **active** member
    (`members.auth_id = sub`, fallback email match like useAuthState).
  - writes to `members`: allowed (role changes etc. happen client-side today);
    creation/deletion still preferably via manage-member.
  - `orders` blocked entirely; `system_settings`/`team_settings` read-write for members
    (license values already HMAC-protected).

## `auth.ts`

- D1 tables: `auth_users(id TEXT PK, email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  password_hash TEXT, created_at TEXT)`, `auth_refresh_tokens(token_hash TEXT PK,
  user_id TEXT, expires_at TEXT, created_at TEXT)`.
- `password_hash` formats: `pbkdf2$<iter>$<saltB64>$<hashB64>` (new, WebCrypto PBKDF2-
  SHA256, 100k iter) and `bcrypt$<hash>` (imported from Supabase; verify with pure-JS
  bcryptjs, then transparently re-hash to pbkdf2 on successful login).
- login: normalize email lowercase; wrong creds → `{error:{message:'Invalid login
  credentials'}}` (the UI matches that substring). Sign access JWT
  `{sub:user.id, email, exp: now+3600}`; create rotating refresh token (random 32B,
  store SHA-256).
- login throttle (`auth_login_attempts(key TEXT PK, failures, window_start,
  locked_until)` plus expiring `auth_login_reservations`, both server-only, no
  `workspace_id`): 5 confirmed failures per email or 20 per IP
  (`CF-Connecting-IP`, canonical IPv6 per /64) within 15 min
  → that key is locked for 15 min → `429` + `Retry-After`,
  `{user:null, session:null, error:{message:'Too many requests; please retry later',
  code:'over_request_rate_limit'}}`, even for the right password. Each attempt
  reserves its slot atomically before the password check (no parallel-burst
  bypass); in-flight slots do not count as failures. Temporary capacity returns
  429 with Retry-After 1 second, without hard-locking the account or IP. Settlement
  is exactly once and tied to the original counter window; success clears only
  confirmed email failures, retaining other live reservations. Unknown emails
  count like real ones; an already-blocked IP cannot create more email rows.
  Reservations expire after 2 minutes; `scheduled()` prunes expired reservations
  and counters in bounded batches of 500. Missing schema/store failure fails
  closed; no session is issued without successful settlement. Missing/invalid
  CF-Connecting-IP returns 503 in production; only explicit loopback development
  URLs allow email-only throttling. X-Forwarded-For is never trusted. Configure
  edge routes to retain visitor IP headers; avoid Pseudo IPv4 overwrite when
  relying on IPv6 /64 limits. Worker subrequests can share an IP bucket.
- refresh: validate + rotate (delete old, issue new). logout: delete refresh token.
- Middleware `requireMember(c)`: verify JWT → find member by auth_id, else by email
  (and heal auth_id link), must be `is_active`; attaches `{authUser, member}`.
- manage-member (functions/manageMember.ts) replicates the edge function: caller must be
  admin/super_admin; create → find-or-create auth_users row (random password unless
  `password` provided in body), reject duplicate member email `此 Email 的成員已存在`,
  insert member `u<ts36><rand4>`; toggle_active → members.is_active + `banned` flag
  column on auth_users (add `banned INTEGER DEFAULT 0`; login rejects banned);
  delete → delete member + auth user + their refresh tokens. Same response shapes
  (`{success,memberId}` / `{error}` in data).

## `realtime.ts` — RealtimeHub DO

- Standard (non-hibernating) WebSockets; state in memory:
  `sockets: Map<WebSocket, {memberId, channels: Map<ch, {bindings, presenceKey?}>}>`,
  `presence: Map<ch, Map<key, payload[]>>` (payload arrays; track() replaces the
  socket's entry wholesale — one entry per socket, keyed by presenceKey=memberId;
  multiple sockets same key → concat arrays in snapshots).
- `/ws` upgrade (token verified in Worker before forwarding). `/notify` POST from
  `db.ts` with `ChangeEvent[]`.
- ClientMsg handling per protocol.ts. join → ack `{t:'joined'}` (+presence snapshot if
  presenceKey). track/untrack → update + broadcast full snapshot to every socket in ch.
  Socket close/error → remove from all channels; presence snapshots broadcast for each
  affected channel. hb → hb_ack.
- change fan-out: for each socket, for each joined channel, for each binding matching
  (table AND (event='*' OR event=eventType) AND (no filter OR filter `col=eq.val`
  matches new?/old? row)) → send `{t:'change', ch, table, eventType, new, old}`.
  **Senders receive their own events** (supabase parity; the app dedupes by id).
- Server-side heartbeat sweep: interval 30 s; sockets silent >45 s get closed
  (client sends hb every 15 s).

## `rpc.ts`

- `check_license` / `activate_license(license_key)` / `reset_license(reset_code)` —
  exact port of the PG functions (see auth-license report): key format
  `LIVO-{STD|PRO}-{email}-{YYYYMMDD|99999999}-{sig8}`, sig8 = first 8 hex of
  HMAC-SHA256(payload, LICENSE_SECRET), payload `LIVO-{TIER}-{email lc}-{expiry}`;
  storage in `system_settings` keys `license` / `installation_id`; installation binding
  + mismatch error codes (`invalid_format|invalid_signature|expired|installation_mismatch`),
  reset code checked against `LICENSE_RESET_CODE` secret. Same JSON response shapes.
- `acquire_field_lock(p_lock_key, p_member_id, p_ttl_seconds)` → upsert into
  `field_locks` if free or expired or same member; returns `{acquired, locked_by?}`.
  `release_field_lock`, `release_all_locks` — plain deletes. All three emit
  field_locks change pings (event only needs to trigger client refetch — send
  eventType UPDATE with new=null? No: send real row INSERT/UPDATE/DELETE like db.ts).

## `functions/` ports

- `slackNotify.ts` (slack-notify, slack-channels, slack-digest): direct Slack Web API
  (`https://slack.com/api/...`, secret `SLACK_BOT_TOKEN`) instead of the old Lovable
  gateway. Payload/blocks pass-through per lib/slackNotify.ts shapes. Pro-license gated
  (shared `requireProfessional` helper reading system_settings). Missing token → clean
  `{error}` (frontend is fire-and-forget).
- `backup.ts` (scheduled-backup): manual body `{manual:true}` + cron entrypoint
  (`scheduled()` in index.ts, `crons: ["0 * * * *"]`) with the same TW-hour and
  interval gating; dumps the 19-table JSON to R2 `backups/backup_YYYYMMDD_HHMMSS.json`,
  inserts backup_history, updates backup_settings.last_backup_at. Optional Slack notify.
- `importJira.ts`: faithful port of the CSV importer (destructive clear + insert flow,
  batch ≤50 rows via db helpers). Change events: send ONE synthetic refresh signal per
  affected table after import (INSERT events per row would flood; config tables trigger
  refetch anyway — send `{table:'tasks',eventType:'UPDATE',new:null,old:null}`-style
  pings for tasks/comments/task_specs/sprints... NO — handlers read payload.new for
  tasks/comments/specs. Instead: after import, no per-row events; clients refetch on
  next load. Import page reloads itself; acceptable parity since Supabase realtime
  also floods here. Decision: emit only sprints/projects config pings (they trigger
  refreshTasks on other clients).
- `ogTask.ts`: per edge-functions report (public task OG page/image).
- `payments.ts`: ECPay AIO v5 — CheckMacValue (sorted params, HashKey/HashIV wrap,
  PHP-style urlencode, SHA-256 uppercase), create-order (prices pro 50000 / std 25000,
  MerchantTradeNo `LV`+TWdate+6), payment-callback (idempotent, license issue via same
  HMAC, Resend email, always `1|OK`), payment-result (HTML), download-source (302 to
  `DOWNLOAD_URL_PRO/STD`). ReturnURL/OrderResultURL now point at
  `https://api.livo-tw.com/api/functions/payment-{callback,result}`.

## Frontend `cfClient.ts` contract

Everything mockClient implements, plus (from the query-surface audit):
lazy **thenable** builders (execute on `.then`), `gt/lt/or`, `select('cols',
{count:'exact', head:true})` exposing `count`, `upsert(..., {onConflict})`,
`insert(...).select().single()`, update-returning optimistic lock, `.catch()` on rpc,
auth with localStorage persistence + auto-refresh + `onAuthStateChange('SIGNED_IN'|
'SIGNED_OUT')`, `getSession/getUser/signOut/signInWithPassword/setSession`,
`storage.from(bucket).upload/download/remove/getPublicUrl` (getPublicUrl = sync concat
`${API_URL}/api/storage/${bucket}/${path}`), `functions.invoke`, `channel()` API with
`on('postgres_changes'|'presence')`, `subscribe(cb)` → 'SUBSCRIBED', `presenceState()`,
`track/untrack`, `removeChannel`, single WS with 15 s hb + backoff [500,1e3,2e3,5e3,1e4]
+ rejoin/retrack on reconnect.

Type shims: replace `Session`/`RealtimeChannel`/`SupabaseClient` imports in app code
with types from cfClient; keep `integrations/supabase/types.ts` (Database/Tables) as-is.

## Data migration (`worker/migrate/`)

1. `export.mjs` — pulls all 49 tables from Supabase (needs `SUPABASE_SERVICE_ROLE_KEY`
   or an authed user token; paginated REST) → `data/*.json`; also lists storage objects.
2. `transform.mjs` — type coercions (bool→0/1 handled by import SQL params; timestamps
   pass through; jsonb → JSON strings), URL rewrite
   `https://<proj>.supabase.co/storage/v1/object/public/task-images/` →
   `https://api.livo-tw.com/api/storage/task-images/` in `comments.attachment_url`,
   `comments.content`, `task_specs.background/requirement/notes`.
3. `import.mjs` — emits chunked INSERT SQL → `wrangler d1 execute --remote`.
4. `copy-storage.mjs` — downloads each storage object, uploads to R2 via `wrangler r2
   object put` (or S3 API).
5. auth users: export via GoTrue admin (service key) incl. bcrypt hashes if accessible
   via pg (else: members keep emails; passwords reset by admin; test accounts recreated
   with `test1234`).

## Local dev / deploy

- `wrangler dev --port 8787` (local D1/R2/DO). `.env.localdb` → `VITE_API_URL=
  http://localhost:8787`, drop supabase vars. `start-livo.bat`: replace Docker section
  with `start wrangler dev` + seed-if-empty; keep static server.
- `.env.production` → `VITE_API_URL=https://api.livo-tw.com`.
- deploy.yml: add job/steps — `npm ci` in worker/, `tsc --noEmit`, `wrangler deploy`,
  `wrangler d1 migrations apply` (schema as d1 migrations dir).
- Secrets to set: `JWT_SECRET`, `LICENSE_SECRET`, `LICENSE_RESET_CODE`, plus optional
  `SLACK_BOT_TOKEN`, `RESEND_API_KEY`, `ECPAY_MERCHANT_ID/HASH_KEY/HASH_IV`,
  `DOWNLOAD_URL_PRO/STD`. (License secret value = the one hard-coded in the old PG
  functions, so existing customer keys keep validating.)
