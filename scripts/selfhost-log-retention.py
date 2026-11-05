#!/usr/bin/env python3
"""Bounded technical-event retention. Preview is default; bindings stay outside Git."""
import argparse
import contextlib
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import unittest

SOURCE_NAMES = (
    "cloudflare.logs.prod", "realtime.logs.prod", "gotrue.logs.prod",
    "deno-relay-logs", "storage.logs.prod.2", "postgREST.logs.prod",
    "postgres.logs", "deno-subhosting-events", "pgbouncer.logs.prod",
)
DATABASE, SCHEMA, GIB = "_supabase", "_analytics", 1024 ** 3
DEFAULTS = {
    "schema_version": 1, "enabled": False, "database": DATABASE,
    "compose_service": "db", "db_user": "supabase_admin", "retention_days": 7,
    "batch_rows": 1000, "max_rows_per_run": 1000000, "max_seconds": 600,
    "min_free_bytes": 2 * GIB, "max_wal_bytes": GIB,
    "max_wal_growth_bytes": GIB // 2,
    "statement_timeout_ms": 15000, "lock_timeout_ms": 1000,
    "status_path": "/var/lib/livo-log-retention/status.json",
    "lock_path": "/run/lock/livo-log-retention.lock",
    "maintenance_inhibit_path": "/run/livo-maintenance.inhibit",
}
EXPECTED_COLUMNS = {"id": "text", "body": "jsonb", "event_message": "text",
                    "timestamp": "timestamp without time zone"}


class Refused(Exception):
    def __init__(self, code, **metadata):
        super().__init__(code)
        self.code, self.metadata = code, metadata


def now_utc():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def literal(value):
    return "'" + str(value).replace("'", "''") + "'"


def identifier(value):
    if not re.fullmatch(r"log_events_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}", value):
        raise Refused("invalid_event_table_name")
    return '"' + SCHEMA + '"."' + value + '"'


def external_path(value):
    p = Path(value).expanduser().absolute()
    if p.is_symlink():
        raise Refused("symlink_state_path")
    p = p.resolve()
    for parent in p.parents:
        if (parent / ".git").exists():
            raise Refused("state_path_inside_git")
    return p


def root_required():
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        raise Refused("root_required")


def secure_parent(p):
    p.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    st = p.parent.stat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o022:
        raise Refused("unsafe_state_parent")


def write_json(path, value):
    p = external_path(path)
    secure_parent(p)
    temp = p.with_name(p.name + ".tmp-" + str(os.getpid()))
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(value, f, sort_keys=True, indent=2)
            f.write("\n")
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, p)
    finally:
        if temp.exists():
            temp.unlink()


def validate_values(cfg, path):
    if cfg["schema_version"] != 1 or cfg["database"] != DATABASE or cfg["retention_days"] != 7:
        raise Refused("unsupported_policy")
    if type(cfg["enabled"]) is not bool:
        raise Refused("invalid_enabled_flag")
    for key in ("container", "compose_project", "compose_service", "db_user"):
        if not isinstance(cfg.get(key), str) or not re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}", cfg[key]):
            raise Refused("invalid_" + key)
    if cfg["compose_service"] != "db":
        raise Refused("unexpected_compose_service")
    bounds = {
        "batch_rows": (1, 10000), "max_rows_per_run": (1, 2000000),
        "max_seconds": (1, 600), "min_free_bytes": (GIB, 2**63 - 1),
        "max_wal_bytes": (16 * 1024**2, 2**63 - 1),
        "max_wal_growth_bytes": (1, 2**63 - 1),
        "statement_timeout_ms": (1, 30000), "lock_timeout_ms": (1, 5000),
    }
    for key, (low, high) in bounds.items():
        if type(cfg[key]) is not int or not low <= cfg[key] <= high:
            raise Refused("invalid_" + key)
    paths = [external_path(cfg[k]) for k in ("status_path", "lock_path", "maintenance_inhibit_path")]
    if len(set(paths + [external_path(path)])) != 4:
        raise Refused("state_paths_overlap")


def load_config(path):
    p = external_path(path)
    if not p.is_file():
        raise Refused("config_missing")
    st = p.stat()
    if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077:
        raise Refused("unsafe_config_permissions")
    try:
        raw = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        raise Refused("invalid_config_json")
    if not isinstance(raw, dict):
        raise Refused("invalid_config")
    cfg = {**DEFAULTS, **raw}
    validate_values(cfg, p)
    if not isinstance(cfg.get("binding"), dict):
        raise Refused("binding_missing")
    return cfg


class Docker:
    def __init__(self, cfg):
        self.cfg, self.target = cfg, cfg["container"]
        self.deadline = time.monotonic() + cfg["max_seconds"]

    def remaining(self):
        return self.deadline - time.monotonic()

    def command(self, args, operation, sql=None, timeout=30):
        if self.remaining() <= 0:
            raise Refused("time_budget")
        timeout = min(timeout, max(0.01, self.remaining()))
        try:
            r = subprocess.run(["docker", "--host", "unix:///var/run/docker.sock", *args],
                               input=sql, text=True, capture_output=True, timeout=timeout, check=False)
        except subprocess.TimeoutExpired:
            raise Refused("command_timeout", operation=operation)
        except OSError:
            raise Refused("docker_unavailable", operation=operation)
        if r.returncode:
            code = "postgres_command_failed" if sql is not None else "docker_command_failed"
            for known in ("retention_binding_changed", "retention_busy"):
                if known in r.stderr:
                    code = known
            raise Refused(code, operation=operation, returncode=r.returncode,
                          stderr_sha256=hashlib.sha256(r.stderr.encode()).hexdigest())
        return r.stdout

    def inspect(self):
        template = ('{"id":{{json .Id}},"running":{{json .State.Running}},'
                    '"restarting":{{json .State.Restarting}},'
                    '"service":{{json (index .Config.Labels "com.docker.compose.service")}},'
                    '"project":{{json (index .Config.Labels "com.docker.compose.project")}},'
                    '"health":{{with (index .State "Health")}}{{json (index . "Status")}}{{else}}null{{end}}}')
        try:
            item = json.loads(self.command(["inspect", "--format", template, self.cfg["container"]], "container_identity"))
        except ValueError:
            raise Refused("invalid_container_metadata")
        if (not item.get("running") or item.get("restarting") or
            item.get("service") != self.cfg["compose_service"] or
            item.get("project") != self.cfg["compose_project"] or
            item.get("health") not in (None, "healthy")):
            raise Refused("container_identity_or_readiness_changed")
        self.target = item["id"]
        return item

    def sql(self, sql, operation="postgres_metadata", timeout=30):
        return self.command(["exec", "-i", self.target, "psql", "-X", "-qAt", "-w",
                             "-v", "ON_ERROR_STOP=1", "-U", self.cfg["db_user"],
                             "-d", DATABASE], operation, sql=sql, timeout=timeout)

    def json_sql(self, sql, operation="postgres_metadata", timeout=30):
        try:
            return json.loads(self.sql(sql, operation, timeout))
        except ValueError:
            raise Refused("invalid_postgres_metadata", operation=operation)

    def metadata(self):
        names = ",".join(literal(x) for x in SOURCE_NAMES)
        sql = """
SELECT jsonb_build_object(
 'cluster_id',(SELECT system_identifier::text FROM pg_control_system()),
 'database_oid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),
 'database',current_database(),'in_recovery',pg_is_in_recovery(),
 'data_directory',current_setting('data_directory'),
 'cutoff_utc',to_char((CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '7 days','YYYY-MM-DD"T"HH24:MI:SS.US'),
 'wal_lsn',pg_current_wal_lsn()::text,
 'wal_bytes',(SELECT coalesce(sum(size),0)::bigint FROM pg_ls_waldir()),
 'sources',coalesce((SELECT jsonb_agg(jsonb_build_object(
   'source_name',s.name,'token',s.token::text,'table_name',c.relname,
   'oid',c.oid::bigint,'relkind',c.relkind,
   'columns',(SELECT jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod))
              FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped),
   'has_foreign_keys',EXISTS(SELECT 1 FROM pg_constraint x WHERE x.contype='f' AND (x.conrelid=c.oid OR x.confrelid=c.oid)),
   'has_user_triggers',EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal),
   'has_rewrite_rules',EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid),
   'has_inheritance',EXISTS(SELECT 1 FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid),
   'total_bytes',CASE WHEN c.oid IS NULL THEN NULL ELSE pg_total_relation_size(c.oid) END
 ) ORDER BY s.name) FROM _analytics.sources s
 LEFT JOIN pg_namespace n ON n.nspname='_analytics'
 LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='log_events_'||replace(s.token::text,'-','_')
 WHERE s.name IN (NAMES)), '[]'::jsonb));
""".replace("NAMES", names)
        return self.json_sql(sql)

    def space(self, meta):
        output = self.command(["exec", self.target, "df", "-Pk", "--",
                               meta["data_directory"], meta["data_directory"].rstrip("/") + "/pg_wal"],
                              "filesystem_space")
        rows = []
        for line in output.splitlines()[1:]:
            m = re.search(r"(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+.+$", line)
            if m:
                rows.append({"total_bytes": int(m[1]) * 1024, "available_bytes": int(m[3]) * 1024})
        if not rows:
            raise Refused("filesystem_space_unknown")
        return {"available_bytes": min(x["available_bytes"] for x in rows), "filesystems_checked": len(rows)}


def binding_from(meta):
    if meta.get("database") != DATABASE or meta.get("in_recovery"):
        raise Refused("wrong_database_or_replica")
    rows = meta.get("sources", [])
    if len(rows) != len(SOURCE_NAMES) or sorted(x.get("source_name", "") for x in rows) != sorted(SOURCE_NAMES):
        raise Refused("source_set_changed")
    result = []
    for item in rows:
        identifier(item.get("table_name") or "")
        if (not item.get("oid") or item.get("relkind") != "r" or item.get("columns") != EXPECTED_COLUMNS
            or item.get("has_foreign_keys") or item.get("has_user_triggers")
            or item.get("has_rewrite_rules") or item.get("has_inheritance")):
            raise Refused("unsupported_source_schema", source_name=item.get("source_name"))
        result.append({k: item[k] for k in ("source_name", "token", "table_name", "oid", "columns")})
    return {"cluster_id": str(meta["cluster_id"]), "database_oid": meta["database_oid"],
            "sources": sorted(result, key=lambda x: x["source_name"])}


def lsn_number(value):
    high, low = value.split("/")
    return (int(high, 16) << 32) + int(low, 16)


def fresh(client, cfg, *, start_lsn=None, check_space=False):
    container, meta = client.inspect(), client.metadata()
    if binding_from(meta) != cfg["binding"]:
        raise Refused("retention_binding_changed")
    if check_space:
        space = client.space(meta)
        if space["available_bytes"] < cfg["min_free_bytes"]:
            raise Refused("insufficient_free_space", **space)
        if meta["wal_bytes"] > cfg["max_wal_bytes"]:
            raise Refused("wal_size_gate", wal_bytes=meta["wal_bytes"])
        if start_lsn:
            delta = lsn_number(meta["wal_lsn"]) - lsn_number(start_lsn)
            if delta < 0 or delta >= cfg["max_wal_growth_bytes"]:
                raise Refused("wal_growth_gate", wal_growth_bytes=delta)
    return meta, container


def preview(client, cfg, cutoff=None):
    meta, container = fresh(client, cfg)
    cutoff = cutoff or meta["cutoff_utc"]
    counts = []
    for item in cfg["binding"]["sources"]:
        limit = cfg["max_rows_per_run"] + 1
        row = client.json_sql("SET statement_timeout=" + str(cfg["statement_timeout_ms"]) + ";\n"
            + "SELECT jsonb_build_object('expired_count_bounded',count(*),'count_limit'," + str(limit)
            + ") FROM (SELECT 1 FROM ONLY " + identifier(item["table_name"])
            + " WHERE timestamp < " + literal(cutoff) + "::timestamp LIMIT " + str(limit)
            + ") q;", "preview_count")
        counts.append({"source_name": item["source_name"], "total_bytes": next(
            x["total_bytes"] for x in meta["sources"] if x["source_name"] == item["source_name"]), **row})
    return {"cutoff_utc": cutoff, "cluster_id": meta["cluster_id"],
            "container_id": container["id"], "sources": counts, "space": client.space(meta),
            "wal_bytes": meta["wal_bytes"], "wal_lsn": meta["wal_lsn"]}


def delete_batch_sql(cfg, item, cutoff, limit):
    table = identifier(item["table_name"])
    order = "\n  ORDER BY timestamp" if item["source_name"] == "cloudflare.logs.prod" else ""
    valid = """(SELECT system_identifier::text FROM pg_control_system())=CLUSTER
 AND (SELECT oid::bigint FROM pg_database WHERE datname=current_database())=DATABASEOID
 AND current_database()='_supabase'
 AND EXISTS(SELECT 1 FROM _analytics.sources WHERE name=SOURCENAME AND token::text=TOKEN)
 AND 'TABLE'::regclass::oid=TABLEOID
 AND (SELECT jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod)) FROM pg_attribute a
      WHERE a.attrelid='TABLE'::regclass AND a.attnum>0 AND NOT a.attisdropped)=COLUMNS
 AND NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='TABLE'::regclass AND NOT tgisinternal)
 AND NOT EXISTS(SELECT 1 FROM pg_rewrite WHERE ev_class='TABLE'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_inherits WHERE inhrelid='TABLE'::regclass OR inhparent='TABLE'::regclass)
 AND NOT EXISTS(SELECT 1 FROM pg_constraint WHERE contype='f' AND (conrelid='TABLE'::regclass OR confrelid='TABLE'::regclass))"""
    replacements = {"CLUSTER": literal(cfg["binding"]["cluster_id"]),
        "DATABASEOID": str(int(cfg["binding"]["database_oid"])), "SOURCENAME": literal(item["source_name"]),
        "TOKEN": literal(item["token"]), "TABLEOID": str(int(item["oid"])),
        "COLUMNS": literal(json.dumps(item["columns"], sort_keys=True)) + "::jsonb", "TABLE": table}
    for key in sorted(replacements, key=len, reverse=True):
        valid = valid.replace(key, replacements[key])
    return f"""BEGIN;
SET LOCAL statement_timeout={cfg['statement_timeout_ms']};
SET LOCAL lock_timeout={cfg['lock_timeout_ms']};
LOCK TABLE ONLY {table} IN ROW EXCLUSIVE MODE;
DO $retention$
DECLARE removed bigint;
BEGIN
 IF NOT pg_try_advisory_xact_lock(hashtextextended('livo:technical-log-retention',0)) THEN
  RAISE EXCEPTION 'retention_busy';
 END IF;
 PERFORM 1 FROM _analytics.sources WHERE name={literal(item['source_name'])} AND token::text={literal(item['token'])} FOR SHARE;
 IF NOT ({valid}) THEN RAISE EXCEPTION 'retention_binding_changed'; END IF;
 WITH expired AS (
  SELECT ctid FROM ONLY {table} WHERE timestamp < {literal(cutoff)}::timestamp{order}
  LIMIT {int(limit)} FOR UPDATE SKIP LOCKED
 ), removed_rows AS (
  DELETE FROM ONLY {table} t USING expired e WHERE t.ctid=e.ctid RETURNING 1
 ) SELECT count(*) INTO removed FROM removed_rows;
 PERFORM set_config('livo.retention_result',jsonb_build_object('deleted_rows',removed)::text,true);
END $retention$;
SELECT current_setting('livo.retention_result')::jsonb;
COMMIT;
"""


@contextlib.contextmanager
def single_instance(path):
    import fcntl
    p = external_path(path)
    secure_parent(p)
    fd = os.open(p, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    try:
        st = os.fstat(fd)
        if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077:
            raise Refused("unsafe_lock_permissions")
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise Refused("already_running")
        yield
    finally:
        os.close(fd)


def apply(client, cfg, initial, progress=None):
    progress = progress if progress is not None else {}
    deleted, batches, attempted, touched = 0, 0, False, set()
    active, reason = list(cfg["binding"]["sources"]), None
    try:
        while active:
            if client.remaining() <= 0:
                reason = "time_budget"
                break
            if deleted >= cfg["max_rows_per_run"]:
                reason = "row_budget"
                break
            if Path(cfg["maintenance_inhibit_path"]).exists():
                raise Refused("maintenance_inhibited")
            item = active.pop(0)
            fresh(client, cfg, start_lsn=initial["wal_lsn"], check_space=True)
            remaining = cfg["max_rows_per_run"] - deleted
            # Persist pending BEFORE sending SQL: a lost COMMIT acknowledgement
            # is unknown, never proof that no rows changed.
            attempted = True
            progress.update(dml_attempted=True, deleted_rows=deleted, batches=batches,
                            status="running", result_unknown=True, result_unknown_until_readback=True,
                            pending_batch={"number": batches + 1, "source_name": item["source_name"],
                                           "limit": min(cfg["batch_rows"], remaining)})
            write_json(cfg["status_path"], progress)
            result = client.json_sql(delete_batch_sql(cfg, item, initial["cutoff_utc"],
                                                       min(cfg["batch_rows"], remaining)),
                                     "delete_expired_batch", timeout=cfg["statement_timeout_ms"] / 1000 + 10)
            count = result["deleted_rows"]
            if type(count) is not int or not 0 <= count <= min(cfg["batch_rows"], remaining):
                raise Refused("invalid_batch_result")
            deleted += count
            batches += 1
            progress.update(deleted_rows=deleted, batches=batches)
            # Clear pending only after both the COMMIT acknowledgement and its
            # bounded count are valid. Persist the ACK before any later guard.
            acknowledged = {**progress, "pending_batch": None, "result_unknown": False,
                            "result_unknown_until_readback": False}
            write_json(cfg["status_path"], acknowledged)
            progress.update(acknowledged)
            if count:
                touched.add(item["table_name"])
                active.append(item)
        after = preview(client, cfg, cutoff=initial["cutoff_utc"])
        expired_remaining = sum(x["expired_count_bounded"] for x in after["sources"])
        if expired_remaining and not reason:
            reason = "expired_backlog"
        vacuumed = []
        for table in sorted(touched):
            if client.remaining() <= 0:
                reason = reason or "time_budget_before_vacuum"
                break
            if Path(cfg["maintenance_inhibit_path"]).exists():
                raise Refused("maintenance_inhibited")
            fresh(client, cfg, start_lsn=initial["wal_lsn"], check_space=True)
            client.sql(f"SET statement_timeout={cfg['statement_timeout_ms']};\n"
                       f"SET lock_timeout={cfg['lock_timeout_ms']};\nVACUUM (ANALYZE) {identifier(table)};",
                       "ordinary_vacuum", timeout=cfg["statement_timeout_ms"] / 1000 + 10)
            vacuumed.append(table)
        return {"status": "partial" if reason else "completed", "reason": reason,
                "deleted_rows": deleted, "batches": batches, "max_batch_rows": cfg["batch_rows"],
                "expired_remaining_bounded": expired_remaining, "vacuumed_tables": len(vacuumed),
                "physical_compaction_performed": False, "dml_attempted": attempted,
                "pending_batch": None, "result_unknown": False,
                "result_unknown_until_readback": False, "preview_after": after}
    except Refused as e:
        return {"status": "partial" if attempted else "refused", "reason": e.code,
                "deleted_rows": deleted, "batches": batches, "dml_attempted": attempted,
                "pending_batch": progress.get("pending_batch"),
                "result_unknown": progress.get("pending_batch") is not None,
                "result_unknown_until_readback": progress.get("pending_batch") is not None,
                "expired_remaining_bounded": None,
                "physical_compaction_performed": False, **e.metadata}


def unresolved_evidence(path):
    """Inspect metadata only; never clear prior unknown results or an ops marker."""
    p = external_path(path)
    marker = p.with_name("manual-result-unknown.json")
    evidence = {"unknown_marker_present": marker.exists() or marker.is_symlink()}
    try:
        fd = os.open(p, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    except FileNotFoundError:
        return evidence if evidence["unknown_marker_present"] else None
    with os.fdopen(fd, "r", encoding="utf-8") as f:
        st = os.fstat(f.fileno())
        if st.st_uid != 0 or not stat.S_ISREG(st.st_mode) or stat.S_IMODE(st.st_mode) & 0o077:
            raise Refused("unsafe_previous_status")
        raw = f.read()
    try:
        previous = json.loads(raw)
        if not isinstance(previous, dict):
            raise ValueError()
    except ValueError:
        raise Refused("invalid_previous_status") from None
    if (previous.get("pending_batch") is not None or previous.get("result_unknown")
            or previous.get("result_unknown_until_readback")):
        evidence["previous_status_sha256"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()
    return evidence if len(evidence) > 1 or evidence["unknown_marker_present"] else None


def last_success(path):
    try:
        p = external_path(path)
        st = p.stat()
        if st.st_uid != 0 or stat.S_IMODE(st.st_mode) & 0o077 or not p.is_file():
            return None
        value = json.loads(p.read_text(encoding="utf-8")).get("last_success_at_utc")
        if not isinstance(value, str) or dt.datetime.fromisoformat(value).tzinfo is None:
            return None
        return value
    except (OSError, ValueError, TypeError, Refused):
        return None


def build_parser():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("command", nargs="?", choices=("bind", "preview", "run"))
    p.add_argument("--config")
    p.add_argument("--scheduled", action="store_true")
    p.add_argument("--apply", action="store_true")
    p.add_argument("--self-test", action="store_true")
    p.add_argument("--container")
    p.add_argument("--project")
    p.add_argument("--db-user", default="supabase_admin")
    p.add_argument("--status-path")
    p.add_argument("--lock-path")
    p.add_argument("--maintenance-inhibit-path")
    return p


def main(argv=None):
    args = build_parser().parse_args(argv)
    if args.self_test:
        return self_test()
    result = {"schema_version": 1, "started_at_utc": now_utc(), "dml_attempted": False}
    status_path = args.status_path or DEFAULTS["status_path"]
    with contextlib.ExitStack() as locks:
        return run_main(args, result, status_path, locks)


def run_main(args, result, status_path, locks):
    # No status mutation is allowed until this invocation owns the instance
    # lock. Even invalid CLI/config errors can race a valid run's next batch.
    preserve_status = True
    root_ok = False
    try:
        root_required()
        root_ok = True
        if not args.config:
            raise Refused("config_missing")
        command = args.command or ("run" if args.scheduled else "preview")
        if args.scheduled and command != "run":
            raise Refused("invalid_scheduled_command")
        if command == "bind":
            if not args.container or not args.project:
                raise Refused("bind_inputs_missing")
            config_path = external_path(args.config)
            if config_path.exists():
                raise Refused("config_already_exists")
            cfg = {**DEFAULTS, "container": args.container, "compose_project": args.project, "db_user": args.db_user}
            for key in ("status_path", "lock_path", "maintenance_inhibit_path"):
                if getattr(args, key):
                    cfg[key] = getattr(args, key)
            validate_values(cfg, config_path)
            status_path = cfg["status_path"]
            preserve_status = True
            locks.enter_context(single_instance(cfg["lock_path"]))
            evidence = unresolved_evidence(status_path)
            if evidence:
                raise Refused("unresolved_previous_result", **evidence)
            preserve_status = False
            client = Docker(cfg)
            client.inspect()
            cfg["binding"] = binding_from(client.metadata())
            cfg["bound_at_utc"] = now_utc()
            write_json(config_path, cfg)
            status_path = cfg["status_path"]
            result.update(status="bound_disabled", enabled=False, source_count=len(SOURCE_NAMES))
        else:
            cfg = load_config(args.config)
            status_path = cfg["status_path"]
            saved_success = last_success(status_path)
            if saved_success:
                result["last_success_at_utc"] = saved_success
            wants_apply = command == "run" and (args.apply or args.scheduled)
            preserve_status = True
            locks.enter_context(single_instance(cfg["lock_path"]))
            evidence = unresolved_evidence(status_path)
            if evidence:
                raise Refused("unresolved_previous_result", **evidence)
            preserve_status = False
            if wants_apply and not cfg["enabled"]:
                raise Refused("disabled")
            if Path(cfg["maintenance_inhibit_path"]).exists():
                raise Refused("maintenance_inhibited")
            client = Docker(cfg)
            initial = preview(client, cfg)
            result.update(preview=initial, enabled=cfg["enabled"])
            if wants_apply:
                fresh(client, cfg, start_lsn=initial["wal_lsn"], check_space=True)
                result.update(status="running", pending_batch=None, result_unknown=False,
                              result_unknown_until_readback=False)
                write_json(status_path, result)
                result.update(apply(client, cfg, initial, result))
            else:
                result.update(status="preview", dml_attempted=False)
    except Refused as e:
        result.update(status="partial" if result.get("dml_attempted") else "refused",
                      reason=e.code, result_unknown=result.get("pending_batch") is not None, **e.metadata)
    except KeyboardInterrupt:
        result.update(status="partial", reason="interrupted_result_requires_readback", result_unknown=True)
    except (OSError, ValueError, KeyError, TypeError) as e:
        result.update(status="partial" if result.get("dml_attempted") else "refused",
                      reason="invalid_runtime_metadata", exception_type=type(e).__name__,
                      result_unknown=result.get("pending_batch") is not None)
    result["completed_at_utc"] = now_utc()
    previous_success = result.get("last_success_at_utc") or last_success(status_path)
    if previous_success:
        result["last_success_at_utc"] = previous_success
    if result.get("status") == "completed":
        result["last_success_at_utc"] = result["completed_at_utc"]
    try:
        # Failed config/lock acquisition and preview must not erase unresolved
        # durable evidence, including the legacy flags emitted by older helpers.
        if not root_ok:
            preserve_status = True
        elif not preserve_status and not result.get("dml_attempted"):
            preserve_status = bool(unresolved_evidence(status_path))
        if preserve_status:
            result["status_preserved"] = True
        else:
            write_json(status_path, result)
    except (OSError, ValueError, Refused):
        result["status_preserved"] = True
        if previous_success:
            result["last_success_at_utc"] = previous_success
        else:
            result.pop("last_success_at_utc", None)
        result["status_write_failed"] = True
        result["status"] = "refused" if not result.get("dml_attempted") else "partial"
    print(json.dumps(result, sort_keys=True))
    return 0 if result.get("status") in ("preview", "completed", "bound_disabled") else 2


def self_test():
    from unittest import mock
    import copy
    import tempfile
    import uuid
    module = sys.modules[__name__]

    def metadata():
        sources = []
        for i, name in enumerate(SOURCE_NAMES):
            token = str(uuid.uuid4())
            sources.append({"source_name": name, "token": token,
                            "table_name": "log_events_" + token.replace("-", "_"),
                            "oid": i + 100, "relkind": "r", "columns": dict(EXPECTED_COLUMNS),
                            "has_foreign_keys": False, "has_user_triggers": False,
                            "has_rewrite_rules": False, "has_inheritance": False, "total_bytes": 1})
        return {"database": DATABASE, "database_oid": 1, "cluster_id": "12345",
                "in_recovery": False, "sources": sources, "wal_bytes": 16 * 1024**2,
                "wal_lsn": "0/100", "data_directory": "/fixture-only"}

    def config():
        return {**DEFAULTS, "container": "fixture-db", "compose_project": "fixture-project",
                "binding": binding_from(metadata()),
                "maintenance_inhibit_path": "/nonexistent-livo-selftest-inhibit"}

    class Tests(unittest.TestCase):
        def test_policy(self):
            self.assertEqual(len(set(SOURCE_NAMES)), 9)
            self.assertEqual(DEFAULTS["min_free_bytes"], 2 * GIB)
            self.assertFalse(DEFAULTS["enabled"])
            self.assertEqual(DEFAULTS["retention_days"], 7)
            self.assertEqual(DEFAULTS["db_user"], "supabase_admin")

        def test_cloudflare_order_is_the_only_batch_sql_change(self):
            cfg = {**DEFAULTS, "binding": {"cluster_id": "12345", "database_oid": 1}}
            legacy_sql = []
            for i, name in enumerate(SOURCE_NAMES):
                token = str(uuid.UUID(int=i + 1))
                item = {"source_name": name, "token": token,
                        "table_name": "log_events_" + token.replace("-", "_"),
                        "oid": i + 100, "columns": dict(EXPECTED_COLUMNS)}
                sql = delete_batch_sql(cfg, item, "2000-01-04T00:00:00", 3)
                if name == "cloudflare.logs.prod":
                    self.assertEqual(sql.count("\n  ORDER BY timestamp\n  LIMIT 3 FOR UPDATE SKIP LOCKED"), 1)
                    sql = sql.replace("\n  ORDER BY timestamp", "", 1)
                else:
                    self.assertNotIn("ORDER BY", sql)
                legacy_sql.append(sql)
            # Frozen before this fix: protects all nine source bindings, guards,
            # cutoffs, locking, transaction and DELETE/ctid SQL byte for byte.
            self.assertEqual(hashlib.sha256("\0".join(legacy_sql).encode()).digest().hex(":"),
                             "2f:2f:3a:1f:0f:c6:9f:e3:73:bb:3a:c7:0d:fe:20:aa:8d:a2:2b:be:74:5a:f7:12:aa:16:d1:41:cf:b3:65:da")

        def test_lsn(self):
            self.assertEqual(lsn_number("1/0") - lsn_number("0/FFFFFFFE"), 2)

        def test_identifier_guard(self):
            for value in ("public.tasks", "log_events_x", 'x"; DROP TABLE x;--'):
                with self.assertRaises(Refused):
                    identifier(value)

        def test_source_guard(self):
            with self.assertRaises(Refused):
                binding_from({"database": DATABASE, "in_recovery": False, "sources": []})

        def test_nonstandard_schema_guard(self):
            for flag in ("has_foreign_keys", "has_user_triggers", "has_rewrite_rules", "has_inheritance"):
                data = metadata()
                data["sources"][0][flag] = True
                with self.assertRaises(Refused):
                    binding_from(data)

        def test_column_type_guard(self):
            data = metadata()
            data["sources"][0]["columns"]["timestamp"] = "bigint"
            with self.assertRaises(Refused):
                binding_from(data)

        def test_git_guard(self):
            with tempfile.TemporaryDirectory(prefix="livo-retention-unit-") as directory:
                root = Path(directory)
                (root / ".git").mkdir()
                with self.assertRaises(Refused):
                    external_path(root / "runtime.json")

        def test_inspect_allows_missing_null_and_healthy_health(self):
            for health in ("absent", None, "healthy"):
                cfg = config()
                client = Docker(cfg)
                reply = {"id": "fixture-container-id", "running": True, "restarting": False,
                         "service": "db", "project": cfg["compose_project"]}
                if health != "absent":
                    reply["health"] = health
                with mock.patch.object(client, "command", return_value=json.dumps(reply)) as command:
                    result = client.inspect()
                self.assertEqual(result.get("health"), None if health == "absent" else health)
                self.assertEqual(client.target, "fixture-container-id")
                template = command.call_args.args[0][2]
                self.assertNotIn(".State.Health", template)
                self.assertIn('index .State "Health"', template)

        def test_inspect_rejects_starting_and_unhealthy(self):
            for health in ("starting", "unhealthy"):
                cfg = config()
                client = Docker(cfg)
                reply = {"id": "fixture-container-id", "running": True, "restarting": False,
                         "service": "db", "project": cfg["compose_project"], "health": health}
                with mock.patch.object(client, "command", return_value=json.dumps(reply)):
                    with self.assertRaises(Refused) as refusal:
                        client.inspect()
                self.assertEqual(refusal.exception.code, "container_identity_or_readiness_changed")

        def test_inspect_missing_health_still_rejects_wrong_labels(self):
            cfg = config()
            client = Docker(cfg)
            reply = {"id": "fixture-container-id", "running": True, "restarting": False,
                     "service": "db", "project": "another-project"}
            with mock.patch.object(client, "command", return_value=json.dumps(reply)):
                with self.assertRaises(Refused):
                    client.inspect()
            self.assertEqual(client.target, cfg["container"])

        def test_global_deadline_prevents_command(self):
            client = Docker(config())
            client.deadline = time.monotonic() - 1
            with mock.patch.object(subprocess, "run") as command:
                with self.assertRaises(Refused) as refusal:
                    client.command(["info"], "unit")
                self.assertEqual(refusal.exception.code, "time_budget")
                command.assert_not_called()

        def test_low_free_space_gate(self):
            data = metadata()
            cfg = config()
            cfg["binding"] = binding_from(data)
            client = mock.Mock()
            client.inspect.return_value = {"id": "fixture-id"}
            client.metadata.return_value = data
            client.space.return_value = {"available_bytes": GIB - 1, "filesystems_checked": 2}
            with self.assertRaises(Refused) as refusal:
                fresh(client, cfg, check_space=True)
            self.assertEqual(refusal.exception.code, "insufficient_free_space")

        def test_wal_growth_gate(self):
            data = metadata()
            cfg = config()
            cfg["binding"] = binding_from(data)
            cfg["max_wal_growth_bytes"] = 1
            client = mock.Mock()
            client.inspect.return_value = {"id": "fixture-id"}
            client.metadata.return_value = data
            client.space.return_value = {"available_bytes": 4 * GIB}
            with self.assertRaises(Refused) as refusal:
                fresh(client, cfg, check_space=True, start_lsn="0/0")
            self.assertEqual(refusal.exception.code, "wal_growth_gate")

        def test_commit_ack_loss_is_partial_unknown(self):
            cfg = config()
            client = mock.Mock()
            client.remaining.return_value = 100
            client.json_sql.side_effect = Refused("command_timeout")
            pending = []
            with mock.patch.object(module, "fresh"), mock.patch.object(module, "write_json", side_effect=lambda p, r: pending.append(copy.deepcopy(r))):
                result = apply(client, cfg, {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"})
            self.assertEqual(result["status"], "partial")
            self.assertTrue(result["dml_attempted"])
            self.assertTrue(result["result_unknown"])
            self.assertEqual(result["deleted_rows"], 0)
            self.assertTrue(pending[0]["dml_attempted"])

        def test_known_count_survives_later_ack_loss(self):
            cfg = config()
            cfg["batch_rows"] = 1
            client = mock.Mock()
            client.remaining.return_value = 100
            client.json_sql.side_effect = [{"deleted_rows": 1}, Refused("invalid_postgres_metadata")]
            with mock.patch.object(module, "fresh"), mock.patch.object(module, "write_json"):
                result = apply(client, cfg, {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"})
            self.assertEqual(result["deleted_rows"], 1)
            self.assertEqual(result["batches"], 1)
            self.assertTrue(result["result_unknown"])

        def test_ack_is_durable_before_normal_guard(self):
            for guard in ("wal_growth_gate", "wal_size_gate", "insufficient_free_space", "maintenance_inhibited"):
                cfg = config()
                cfg["batch_rows"] = 1
                client = mock.Mock()
                client.remaining.return_value = 100
                client.json_sql.return_value = {"deleted_rows": 1}
                snapshots = []
                progress = {}
                with mock.patch.object(module, "fresh", side_effect=[None, Refused(guard)]), mock.patch.object(
                        module, "write_json", side_effect=lambda p, r: snapshots.append(copy.deepcopy(r))):
                    result = apply(client, cfg, {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"}, progress)
                self.assertEqual((result["status"], result["reason"], result["deleted_rows"], result["batches"]),
                                 ("partial", guard, 1, 1))
                self.assertFalse(result["result_unknown"])
                self.assertFalse(result["result_unknown_until_readback"])
                self.assertIsNone(result["pending_batch"])
                self.assertEqual(snapshots[0]["pending_batch"]["number"], 1)
                self.assertIsNone(snapshots[1]["pending_batch"])
                self.assertEqual(snapshots[1]["deleted_rows"], 1)
                self.assertFalse(snapshots[1]["result_unknown_until_readback"])

        def test_invalid_ack_and_sql_failure_remain_unknown(self):
            for response in ({"deleted_rows": "1"}, {}, Refused("postgres_command_failed")):
                client = mock.Mock()
                client.remaining.return_value = 100
                if isinstance(response, Exception):
                    client.json_sql.side_effect = response
                else:
                    client.json_sql.return_value = response
                progress = {}
                with mock.patch.object(module, "fresh"), mock.patch.object(module, "write_json"):
                    try:
                        result = apply(client, config(), {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"}, progress)
                    except KeyError:
                        result = progress
                self.assertTrue(result["result_unknown"])
                self.assertIsNotNone(result["pending_batch"])
                self.assertEqual(result["deleted_rows"], 0)

        def test_ack_persist_failure_remains_pending(self):
            client = mock.Mock()
            client.remaining.return_value = 100
            client.json_sql.return_value = {"deleted_rows": 1}
            progress = {}
            with mock.patch.object(module, "fresh"), mock.patch.object(module, "write_json", side_effect=[None, OSError()]):
                with self.assertRaises(OSError):
                    apply(client, config(), {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"}, progress)
            self.assertEqual(progress["deleted_rows"], 1)
            self.assertIsNotNone(progress["pending_batch"])
            self.assertTrue(progress["result_unknown"])

        def smoke(self, argv, cfg, client=None, initial=None, disk=None, load_error=None, lock_error=None):
            disk = disk if disk is not None else {}
            def writer(path, value):
                disk.clear()
                disk.update(copy.deepcopy(value))
            with contextlib.ExitStack() as stack:
                stack.enter_context(mock.patch.object(module, "root_required"))
                stack.enter_context(mock.patch.object(module, "load_config", return_value=cfg, side_effect=load_error))
                constructor = stack.enter_context(mock.patch.object(module, "Docker", return_value=client))
                stack.enter_context(mock.patch.object(module, "single_instance", side_effect=lock_error or (lambda p: contextlib.nullcontext())))
                stack.enter_context(mock.patch.object(module, "write_json", side_effect=writer))
                stack.enter_context(mock.patch.object(module, "last_success", side_effect=lambda p: disk.get("last_success_at_utc")))
                stack.enter_context(mock.patch.object(module, "preview", return_value=initial or {}))
                stack.enter_context(mock.patch.object(module, "fresh"))
                stack.enter_context(mock.patch.object(module, "unresolved_evidence", side_effect=lambda p:
                    {"previous_status_sha256": "fixture"} if disk.get("pending_batch") is not None
                    or disk.get("result_unknown") or disk.get("result_unknown_until_readback") else None))
                output = stack.enter_context(contextlib.redirect_stdout(io.StringIO()))
                code = main(argv)
                result = json.loads(output.getvalue())
            return code, result, constructor

        def test_exact_scheduled_disabled_argv_no_docker(self):
            code, result, constructor = self.smoke(["--scheduled", "--config", "/fixture/config.json"], config())
            self.assertEqual(code, 2)
            self.assertEqual(result["reason"], "disabled")
            self.assertFalse(result["dml_attempted"])
            constructor.assert_not_called()

        def test_default_preview_and_run_without_apply(self):
            for args in (["--config", "/fixture/config.json"], ["run", "--config", "/fixture/config.json"]):
                client = mock.Mock()
                code, result, _ = self.smoke(args, config(), client)
                self.assertEqual(code, 0)
                self.assertEqual(result["status"], "preview")
                self.assertFalse(result["dml_attempted"])
                client.json_sql.assert_not_called()

        def test_prelock_failures_never_overwrite_even_known_ack_status(self):
            cases = [([], None, None),
                     (["--config", "/fixture/config.json"], Refused("invalid_config_json"), None),
                     (["--config", "/fixture/config.json"], None, Refused("already_running"))]
            for argv, load_error, lock_error in cases:
                disk = {"status": "running", "pending_batch": None, "result_unknown": False,
                        "result_unknown_until_readback": False, "deleted_rows": 17, "batches": 3}
                expected = copy.deepcopy(disk)
                code, result, constructor = self.smoke(argv, config(), disk=disk,
                                                       load_error=load_error, lock_error=lock_error)
                self.assertEqual(code, 2)
                self.assertTrue(result["status_preserved"])
                self.assertEqual(disk, expected)
                constructor.assert_not_called()

        def test_unknown_preview_disabled_and_apply_preserve_status(self):
            for old in ({"result_unknown": True}, {"result_unknown_until_readback": True},
                        {"pending_batch": {"number": 2}}):
                for argv in (["--config", "/fixture/config.json"], ["--scheduled", "--config", "/fixture/config.json"]):
                    disk = {**old, "deleted_rows": 17, "batches": 3}
                    expected = copy.deepcopy(disk)
                    code, result, constructor = self.smoke(argv, config(), disk=disk)
                    self.assertEqual(code, 2)
                    self.assertEqual(result["reason"], "unresolved_previous_result")
                    self.assertTrue(result["status_preserved"])
                    self.assertEqual(disk, expected)
                    constructor.assert_not_called()

        def test_main_interrupt_after_pending_preserves_unknown(self):
            cfg = config()
            cfg["enabled"] = True
            client = mock.Mock()
            client.remaining.return_value = 100
            client.json_sql.side_effect = KeyboardInterrupt()
            code, result, _ = self.smoke(["--scheduled", "--config", "/fixture/config.json"], cfg, client,
                {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"})
            self.assertEqual(code, 2)
            self.assertTrue(result["result_unknown"])
            self.assertIsNotNone(result["pending_batch"])

        def test_last_success_survives_partial_pending(self):
            cfg = config()
            cfg["enabled"] = True
            client = mock.Mock()
            client.remaining.return_value = 100
            client.json_sql.side_effect = Refused("command_timeout")
            old = "2026-01-01T00:00:00+00:00"
            disk = {"last_success_at_utc": old}
            code, result, _ = self.smoke(["--scheduled", "--config", "/fixture/config.json"], cfg, client,
                                         {"wal_lsn": "0/0", "cutoff_utc": "2026-01-01T00:00:00"}, disk)
            self.assertEqual(code, 2)
            self.assertEqual(result["status"], "partial")
            self.assertEqual(result["last_success_at_utc"], old)
            self.assertTrue(result["result_unknown"])
            self.assertEqual(disk["last_success_at_utc"], old)

    run = unittest.TextTestRunner(stream=io.StringIO()).run(unittest.defaultTestLoader.loadTestsFromTestCase(Tests))
    summary = {"status": "passed" if run.wasSuccessful() else "failed", "tests": run.testsRun,
               "failures": len(run.failures), "errors": len(run.errors)}
    if not run.wasSuccessful():
        summary["failed_tests"] = [case.id() for case, _ in [*run.failures, *run.errors]]
    print(json.dumps(summary))
    return 0 if run.wasSuccessful() else 1


if __name__ == "__main__":
    sys.exit(main())
