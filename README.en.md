# LIVO

A project collaboration system built for Chinese-speaking teams. Keep tasks, knowledge and meeting records, Bug repair and verification, and release records in one workflow, with links back to the original cards and documents.

Self-host with Docker on your server or intranet, or deploy to Cloudflare. Open source under the [AGPL-3.0](LICENSE): self-hosting is free, with no member limit or license key. Enable QA, approvals, Slack actions and releases when your team needs them.

[中文說明](README.md) · [Live demo](https://livo-tw.com/demo/?demo=pro) · [Website](https://livo-tw.com) · [Blog](https://livo-tw.com/articles)

[![CI](https://github.com/livo-tw/livo/actions/workflows/ci.yml/badge.svg)](https://github.com/livo-tw/livo/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

![LIVO board](docs/images/board.jpg)

The live demo needs no sign-up. Everything you change stays in that browser tab and is gone when you close it. Demo mode does not connect to Slack or create real member invitations.

## Features

- **Tasks and sprints**: boards, lists, backlog, Gantt charts and dependencies; subtasks, custom and required fields, templates, transition rules and time tracking. Carry unfinished work into the next sprint. Assignment and review responsibility take effect immediately, without an acceptance step.
- **Personal work**: assigned and reviewed tasks, plus Bugs you repair or test, in one place. Set your own product line and project order in the sidebar without changing teammates' order.
- **Knowledge and meetings**: shared and project pages, a three-level tree, rich text, search, version restore and comments. Set view, edit and comment access by role, position or member; download attachments through authenticated access. Keep private drafts, confirm published document revisions, and link decisions to tasks or Bugs.
- **Document imports**: preview and review Markdown, DOCX, PDF (including local OCR) and explicitly allowed Notion pages before committing them. Retain original sources and source versions. Requires a separately configured optional private processor.
- **QA Bugs**: dedicated board and list, repair and QA owners, custom fields and display workflows, private evidence attachments, repair and verification across environments, and cross-team handoffs. Bugs close automatically after all required environments have deployment records and their latest formal verification passes.
- **Deployment and releases**: a shared deployment queue reuses original tasks and Bugs. Release batches collect versions, QA/UAT evidence, exceptions and records of manual deployment, rollback and recovery across projects and components.
- **Reports and stand-ups**: daily, weekly and monthly reports assembled from task status, with editing, history and scheduled Slack delivery. Stand-ups support timers, groups, speaking order and temporary participant exclusion/restoration. Dashboards and optional approvals are also included.
- **Collaboration and integrations**: live updates, field edit locks, in-app notifications, email (Resend), Slack, webhooks and personal API tokens. Slack capabilities depend on deployment and configuration; see the comparison below.
- **Team administration**: members and roles, single-use invitation links, activity logs, JSON backup/export and Jira CSV import. Complete recovery also requires database and file backups.
- **Interface**: Traditional Chinese, Simplified Chinese and English; dark and light themes; `Ctrl/Cmd + K` search; mobile navigation and touch board controls.

| Gantt chart | Work report |
| --- | --- |
| ![Gantt chart](docs/images/gantt.jpg) | ![Work report](docs/images/report.jpg) |
| **Dashboard** | **Stand-up** |
| ![Dashboard](docs/images/dashboard.jpg) | ![Stand-up](docs/images/standup.jpg) |

### Enable the features your team needs

Administrators manage approvals, QA Bugs, Slack actions, release workspace and the deployment queue in **System administration → Feature switches**. These optional features are off on fresh installs; knowledge pages and ordinary tasks need no switch. Disabling an optional feature retains its data. Slack and document processing still require their own service configuration.

Invitation links let colleagues enter a name, an Email-format login identifier and a password to join directly, without a confirmation email or mail service. Each link works once, expires after seven days and can be revoked by an administrator. Direct joining does not verify ownership of the supplied email.

#### Approvals

Open **System administration → Feature switches** to enable the approval workflow, rules and notifications for your team. Only admins and super admins can change it. Both Docker and Cloudflare are supported, with no third-party service or license key required. The `?demo=pro` demo starts with approvals on and uses only in-memory data.

Existing installations with any approval rules or requests keep approvals on after upgrading. Turning approvals off lists all pending tasks: cancel or choose **Withdraw all and turn off**. Withdrawal clears each task's pending state and records the activity through the normal withdrawal path. With approvals off, approval screens, status interception and notifications disappear. Rules and history are retained and become visible when enabled again. Existing Realtime broadcasts propagate changes; offline clients pick them up on the next load. Rerun the Docker installer to apply the migration, or apply the updated `worker/schema.sql` on Cloudflare.

### Workflows and deployment differences

QA supports direct workflow state changes as well as formal repair, deployment and PASS/FAIL/BLOCKED records. Selecting PASS or closed manually changes the work state without creating verification evidence. Automatic closure requires actual deployment and the latest formal PASS for every required target in the current repair cycle. The shared queue creates no extra task, and release batches do not execute deployments or automatically change task or Bug states.

Knowledge and meeting pages can create or link tasks and Bugs with references to the source page and paragraph. Document checklists do not replace task completion or QA verification. Ancestor page restrictions still apply, and administrators do not automatically gain access to restricted pages.

| Capability | Docker self-hosting | Cloudflare |
| --- | --- | --- |
| Tasks, knowledge and meetings, QA, deployment queue, release data | Supported | Supported |
| Ordinary task Slack panel, card creation and comments | Socket Mode; bot, app token and outbound access required | This ordinary task interaction entry is unavailable |
| QA Slack actions and Bug thread synchronization | Socket Mode; events and scopes required | Signed HTTP endpoint; signing secret and events required |
| Slack knowledge search | Existing Socket Mode relay | Signed HTTP endpoint |
| Slack release confirmation and delivery | Existing integration and channel routes must be configured | Unsupported for ordinary D1 login identities |
| Document parsing and OCR | Optional internal processor, off by default | Configure a trusted private processor; Workers do not run native parsers |

On Docker, `/livo` opens the private task panel. Use `/livo new Title` to create a card, `/livo comment ABC-123` to comment, or `/livo context ABC-123` to read task background and requirements. QA uses `/livo bug ...`; knowledge search uses `/livo kb keyword`. Every action checks current membership and data access. Manual account mappings require a super administrator; members can unlink their own Slack account.

Task notifications can route by product line or project, with a durable queue, deduplication and rate-limit retries. Uncertain delivery outcomes are held for review. Socket Mode needs no public Request URL on an intranet, but outbound HTTPS/WebSocket access is still required. Deploying code does not configure a real Slack app; complete setup and acceptance checks in your own environment after upgrading.

### Documentation

- [Docker installation, upgrades and Slack setup](release-template/README.md) (Chinese)
- [Task responsibility and Slack panels](docs/task-work-slack.md) · [Deadlines and due reminders](docs/task-planning-slack.md)
- [Knowledge and meeting workflows](KNOWLEDGE-WORKFLOW.md) · [Page permissions](docs/knowledge-permissions.md) · [Private document imports](docs/knowledge-import.md)
- [QA Bugs and Slack](QA-WORKFLOW.md) · [QA, automatic closure and shared deployment queue](docs/qa-slack-and-deployment-workflow.md)
- [Release batches and threads](release-template/README.md#跨卡發布批次與持續討論串) · [Use cases and blog articles](https://livo-tw.com/articles)

## Getting started

Pick one of three ways.

### 1. Run it locally (development)

Needs Node.js 22 or later. The backend runs under Cloudflare's `wrangler dev`, which emulates the database and file storage on your machine, so no Cloudflare account is needed.

```bash
git clone https://github.com/livo-tw/livo.git livo
cd livo
npm ci

# backend
cd worker
npm ci
cp .dev.vars.example .dev.vars      # set JWT_SECRET to a long random string
npm run db:migrate:local            # create the local database
npm run db:seed:local               # demo data: 20 fictional members, password test1234
npm run dev                         # API on http://localhost:8787

# frontend (second terminal, repository root)
cp .env.example .env.development
npm run dev                         # open http://localhost:5173/demo/
```

Sign in as `admin@livo.test` / `test1234`. To start empty instead, replace `npm run db:seed:local` with the line below. It creates your own admin account and prints the password once:

```bash
node scripts/init-instance.mjs --local --email you@example.com --name "Your Name"
```

### 2. Self-host with Docker (store data on your own server)

Good for a company intranet or your own server. Needs Docker with Compose; the machine that builds the package also needs Node.js 22 or later.

```bash
git clone https://github.com/livo-tw/livo.git livo
cd livo
npm ci
node scripts/build-release.mjs      # builds release/livo-release/ (Linux/macOS need the zip command)

cp -R release/livo-release ~/livo   # install outside the repo so rebuilding never touches it
cd ~/livo
sh install.sh                       # on Windows, copy the folder out and double-click install.bat
```

The installer generates keys and passwords unique to your install, loads the database schema and asks you to create the first admin. Then open <http://localhost:3000/>. Operations and troubleshooting are covered in [release-template/README.md](release-template/README.md) (in Chinese), including:

- **Upgrading** (升級到新版): copy the new files over your install folder (keep `docker/.env`) and run the installer again. New database upgrades are applied after an automatic backup and never delete data.
- **Personal API keys** (用 API 金鑰操作 LIVO): let an AI assistant or a script read and write LIVO data through the API with exactly the permissions of the member the key is bound to — no server or database access needed.

### 3. Deploy to Cloudflare

The backend uses Workers, D1, R2 and Durable Objects; the frontend goes to Pages. Sign in from `worker/` first with `npx wrangler login`.

```bash
cd worker
npx wrangler d1 create livo-db              # paste the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create livo-attachments
npx wrangler secret put JWT_SECRET          # paste a long random string
npm run db:migrate:remote
node scripts/init-instance.mjs --remote --email you@example.com --name "Your Name"
npx wrangler deploy                         # note the API URL, e.g. https://livo-api.<account>.workers.dev

cd ..
VITE_API_URL=https://livo-api.<account>.workers.dev VITE_LOCAL_MODE=false npx vite build --outDir dist
mkdir -p site/demo && cp -r dist/* site/demo/
printf '/demo/*  /demo/index.html  200\n' > site/_redirects
npx wrangler pages deploy site --project-name livo
```

Finally add your frontend origin (for example `https://livo.pages.dev`) to `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`, set `APP_BASE_URL` and `API_BASE_URL`, and run `npx wrangler deploy` again. For email notifications also set `RESEND_API_KEY` (see the end of `wrangler.jsonc`).

## Architecture

| | |
| --- | --- |
| Frontend | React 18, TypeScript, Vite, Tailwind CSS (shadcn/ui), TipTap editor |
| Backend (Cloudflare) | Workers (Hono), D1 (SQLite), Durable Objects (live updates), R2 (attachments) |
| Backend (Docker) | Self-hosted Supabase: Postgres, PostgREST, Realtime, Edge Functions |
| Sign-in | Own JWT implementation (1-hour access token, rotating 30-day refresh token), PBKDF2 passwords |

```
src/                    frontend
worker/                 Cloudflare Worker backend (schema.sql, seed.sql, DESIGN.md)
docker/                 Docker self-host stack (Supabase config and edge functions)
supabase/migrations/    database schema for the Docker stack
release-template/       Docker installer and deployment guide
scripts/build-release.mjs  builds the Docker package
```

## Known limitations

- From source (`npm run dev`) or on Cloudflare the app is served under the `/demo/` path; the Docker install serves it at the site root (for example `http://localhost:3000/`).
- Jira CSV import supports English and Simplified Chinese header aliases; other headers need conversion first. Move attachments with the separate `scripts/jira-attachments.mjs` tool; CSV alone does not transfer them automatically.
- Document imports require a private processor and import permissions. Each source is limited to 10 MB and PDFs to 40 pages. OCR and unsupported content produce review warnings; Notion child pages must be individually allowed and selected.
- JSON backup is not a complete server backup. Check its coverage manifest for private knowledge and files; some restore and cross-database migration paths are guarded. Complete recovery needs database and file-storage backups. QA attachments do not move automatically between Docker and R2.
- Slack, email and webhooks send configured notification content to external services. Without those integrations, an intranet installation can remain internal. Ordinary task and QA thread synchronization have different scopes; see the documentation above.
- Traditional Chinese is the most complete language; some screens are not translated to Simplified Chinese or English yet.

## License

LIVO is released under the [GNU AGPL-3.0](LICENSE). You may use, modify and sell it for free. If you modify it and let other people use it over a network, you must offer those users your modified source code. Running an unmodified copy for your own company requires nothing.

For a commercial license (terms other than the AGPL) or paid onboarding (deployment, Jira migration, training, annual support), see <https://livo-tw.com/pricing> or email service@livo-tw.com.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Your first pull request needs a signed [CLA](CLA.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Author

Lingye, an independent developer in Taiwan with ten years as a product manager. LIVO started as a tool for their own team.
