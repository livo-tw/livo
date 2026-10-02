# LIVO

A project management system built for Chinese-speaking teams: boards, Gantt charts, sprints, daily and weekly reports written from task status, stand-ups and approvals. Run it on your own machine with Docker (it works fine on an offline intranet) or deploy it to Cloudflare. Open source under the [AGPL-3.0](LICENSE).

[中文說明](README.md) · [Live demo](https://livo-tw.com/demo/?demo=pro) · [Website](https://livo-tw.com)

[![CI](https://github.com/livo-tw/livo/actions/workflows/ci.yml/badge.svg)](https://github.com/livo-tw/livo/actions/workflows/ci.yml)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)

![LIVO board](docs/images/board.jpg)

The live demo needs no sign-up. Everything you change stays in that browser tab and is gone when you close it.

## Features

- **Knowledge base**: shared and project pages, a three-level tree, rich text and images, attachments, cross-page search, and the latest 20 previous versions with restore. Edit locks prevent concurrent overwrites. Members can create and edit; admins can restrict individual pages and archive them. Available on Docker and Cloudflare with no extra setup, third-party service or feature switch.

- **Views**: board, list, backlog, Gantt chart with task dependencies, my tasks
- **Sprints**: plan and complete sprints; unfinished tasks can move into the next one
- **Work reports**: daily, weekly and monthly reports assembled from task status; edit them, keep a history, or send them to Slack on a schedule
- **Stand-up mode**, **approval workflows**, **dashboard**
- **Tasks**: subtasks, dependencies, custom fields, required fields, templates, status transition rules, time tracking
- **Collaboration**: live updates, and a lock with a notice when two people edit the same field
- **Notifications and integrations**: in-app, email (Resend), Slack, webhooks, personal API tokens
- **Administration**: members and roles, activity log, JSON backup and export, Jira CSV import
- **Feature switches**: administrators enable or disable approvals for the whole team; off on fresh installs
- **Interface**: Traditional Chinese, Simplified Chinese and English; dark and light themes; `Ctrl/Cmd + K` search

| Gantt chart | Work report |
| --- | --- |
| ![Gantt chart](docs/images/gantt.jpg) | ![Work report](docs/images/report.jpg) |
| **Dashboard** | **Stand-up** |
| ![Dashboard](docs/images/dashboard.jpg) | ![Stand-up](docs/images/standup.jpg) |

### Approval feature switch

Open **System administration → Feature switches** to enable the approval workflow, rules and notifications for your team. Only admins and super admins can change it. Both Docker and Cloudflare are supported, with no third-party service or license key required. The `?demo=pro` demo starts with approvals on and uses only in-memory data.

Existing installations with any approval rules or requests keep approvals on after upgrading. Turning approvals off lists all pending tasks: cancel or choose **Withdraw all and turn off**. Withdrawal clears each task's pending state and records the activity through the normal withdrawal path. With approvals off, approval screens, status interception and notifications disappear. Rules and history are retained and become visible when enabled again. Existing Realtime broadcasts propagate changes; offline clients pick them up on the next load. Rerun the Docker installer to apply the migration, or apply the updated `worker/schema.sql` on Cloudflare.

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

### 2. Self-host with Docker (your data never leaves your machine)

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
- Jira import only understands CSV column names from Jira's Simplified Chinese interface for now.
- Traditional Chinese is the most complete language; some screens are not translated to Simplified Chinese or English yet.

## License

LIVO is released under the [GNU AGPL-3.0](LICENSE). You may use, modify and sell it for free. If you modify it and let other people use it over a network, you must offer those users your modified source code. Running an unmodified copy for your own company requires nothing.

For a commercial license (terms other than the AGPL) or paid onboarding (deployment, Jira migration, training, annual support), see <https://livo-tw.com/pricing> or email service@livo-tw.com.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Your first pull request needs a signed [CLA](CLA.md). Please report security problems privately as described in [SECURITY.md](SECURITY.md), not in a public issue.

## Author

Lingye, an independent developer in Taiwan with ten years as a product manager. LIVO started as a tool for their own team.

### Slack actions (optional, Docker self-hosting)

Docker task notifications can route product lines or projects to specific channels, using a durable queue and one thread per card and channel. Rate limits retry automatically; uncertain delivery outcomes are held for review to avoid duplicate posts. This is off by default; see the [Docker setup guide](release-template/README.md).

Create cards with `/livo`, add comments with `/livo comment ABC-123`, or use message shortcuts and a permission-filtered card picker.
Socket Mode connects outbound, so an internal installation needs no public Request URL. No new npm dependencies are required.
Off by default: an administrator enables **Feature switches → Slack actions**, then configures the bot in **Integrations → Slack**.
Enable Socket Mode and Interactivity in the Slack app. Create an app-level token with `connections:write`, add `/livo` and the `livo_create_task` / `livo_comment_task` message shortcuts, add the `commands` bot scope and reinstall the app.
Set `SLACK_APP_TOKEN` and `APP_BASE_URL` in `docker/.env` and rerun the installer. It generates the internal secret once and preserves existing values.
Accounts bind by email to active LIVO logins; when the emails differ, an administrator can map the Slack account manually in the Slack settings. Searches and writes use the member's normal permissions. Disabling the feature retains configuration and history.
Cloudflare hides this feature; demo mode makes no backend calls. See the [Docker setup guide](release-template/README.md) for scopes, Compose commands, account binding and limits.
