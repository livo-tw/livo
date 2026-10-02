# QA PostgreSQL acceptance

This opt-in check uses a **new disposable PostgreSQL container**, never an installed LIVO database. It needs Node 18+, an already running local Linux Docker daemon, and the image `postgres:15.8-alpine` already present. The image matches the PostgreSQL 15.8 major/minor used by the delivery compose; the report records its actual image ID. It does not install/start Docker, pull an image, read `.env`/credentials, connect to a team server, or use existing volumes.

From `LIVO-local-ready`:

```powershell
# Safe preparation only: no Docker command is executed.
node scripts/test-qa-postgres.mjs --plan

# After permission to use the local runtime, prepare the fixed image if absent:
docker pull postgres:15.8-alpine

# Actual acceptance; result outside the repository.
node scripts/test-qa-postgres.mjs --run --report "$env:TEMP/livo-qa-postgres-result.json"
```

Do not treat `--plan`, runner unit tests, or migration lint as a PostgreSQL pass. Only `--run` exiting 0 with `status: passed`, the expected assertion count, `migrationPasses: 2`, and `cleanup: removed-and-verified` is a successful run. A failure exits nonzero and, when `--report` is provided, writes the failing SQL/cleanup summary. No product deployment is involved.

The runner accepts only Docker Desktop's local named pipes and `/var/run/docker.sock` or `/run/docker.sock`. It pins that endpoint for all calls; remote contexts/TCP/SSH are rejected. Each run creates a random name and ownership label. Its command is equivalent to:

```text
docker --host <verified-local-endpoint> create --pull=never
  --name livo-qa-pg-<random> --label com.livo.qa-postgres-test=<uuid>
  --network none --cpus 1 --memory 512m --memory-swap 512m
  --pids-limit 128 --shm-size 64m
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=256m
  --security-opt no-new-privileges:true --restart no
  --env POSTGRES_HOST_AUTH_METHOD=trust --env POSTGRES_DB=livo_qa_test
  postgres:15.8-alpine postgres -c listen_addresses=
  -c shared_buffers=32MB -c max_connections=20
  -c statement_timeout=15000 -c lock_timeout=3000
```

There are no published ports or host/persistent-volume mounts. PostgreSQL trusts only its isolated container-local Unix socket; networking is disabled. The runner starts only that new container, sends SQL via `docker exec -i ... psql -X -v ON_ERROR_STOP=1`, and has a 240-second execution deadline plus bounded cleanup calls. It verifies exact container ID and ownership label before removing only its own container, then checks absence. It never runs `compose`, `prune`, or volume deletion. If forcibly killed or Docker disappears during cleanup, the error includes the unique container name for manual inspection; do not remove unrelated containers.

`scripts/lib/qa-postgres-fixture.sql` models only QA's pre-existing dependencies: members, projects/tasks, settings, notifications and Storage metadata. The real `20261002_qa_workflow.sql` and `20261002_qa_workflow_settings.sql` are each executed twice using the existing release transaction/ledger wrapper and migration lint. The source SQL is not rewritten to make it pass. The second pass follows populated QA data and checks that every QA row and workflow setting survives unchanged and the release ledger stays deduplicated.

The assertions cover:

- `anon`/`authenticated` table and RPC denial, including member/admin/super-admin JWT subjects; service-role execute grants.
- Active member report/comment, first admin triage, assigned developer and QA owner checks, stale-version rejection, receipt replay/hash/actor binding, and atomic audit/notification effects.
- Live member disablement and admin demotion; QA absent/false/string-true gates; Docker's default-only workspace checks on all QA tables, aggregate changes and restore input.
- Admin/super-admin workflow save, member denial, invalid names/order, and direct PostgREST-style insert/update/delete bypass denial.
- Super-admin-only restore preflight and nonempty restore with readback/replay deduplication; private evidence metadata/owner checks, idempotent finalization, completed-object protection, and restrictive Storage policies over a permissive legacy policy.
- Inbox deduplication, lease/backoff, completion payload deletion, Slack toggle and 30-day retention.

This is real PostgreSQL SQL execution when run, but uses a minimal baseline. It does **not** verify the full delivery baseline, HTTP routing, GoTrue/JWT verification, shared domain business transitions, actual Storage file bytes/signed upload service, Slack delivery, or concurrent multi-session races; those need separate existing service/unit/E2E checks.
