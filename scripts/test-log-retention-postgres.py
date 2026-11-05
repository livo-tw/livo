#!/usr/bin/env python3
"""Real PostgreSQL 15.8 regression for the bounded technical-log helper.

The fixture is root-owned and disposable. No host ports, host mounts, real
configuration, production Docker context, daemon startup, or global prune is used.
Only one final JSON summary is printed; SQL rows and helper payloads stay private.
"""
import copy
import contextlib
import io
from unittest import mock
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import select
import stat
import subprocess
import sys
import tempfile
import time
import uuid

sys.dont_write_bytecode = True
HELPER = Path(__file__).resolve().with_name('selfhost-log-retention.py')
IMAGE = 'postgres:15.8-alpine'
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']


class FixtureFailure(Exception):
    pass


def quoted(value):
    return "'" + str(value).replace("'", "''") + "'"


def table_name(token):
    return 'log_events_' + str(token).replace('-', '_')


def relation(name):
    if not re.fullmatch(r'log_events_[0-9a-f]{8}(?:_[0-9a-f]{4}){3}_[0-9a-f]{12}', name):
        raise FixtureFailure('invalid_fixture_table_identifier')
    return '"_analytics"."' + name + '"'


def command(args, *, input_text=None, timeout=120, stage='command'):
    try:
        result = subprocess.run(args, input=input_text, text=True, encoding='utf-8',
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False)
    except (OSError, subprocess.TimeoutExpired):
        raise FixtureFailure(stage + '_unavailable_or_timeout') from None
    if result.returncode:
        state = re.search(r'(?:ERROR|FATAL):\s+([A-Z0-9]{5})\b', result.stderr)
        suffix = '_sqlstate_' + state.group(1) if state else ''
        raise FixtureFailure(stage + '_failed' + suffix)
    return result.stdout


def write_config(path, config):
    # mkdtemp's root-owned 0700 parent is checked by the production helper.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as output:
        json.dump(config, output, sort_keys=True)
        output.write('\n')
    os.chmod(path, 0o600)


def json_file(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def load_sources():
    spec = importlib.util.spec_from_file_location('livo_retention_fixture_helper', HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    names = tuple(module.SOURCE_NAMES)
    if len(names) != 9 or len(set(names)) != 9:
        raise FixtureFailure('vendor_source_contract_changed')
    return names


class Fixture:
    def __init__(self, scratch):
        self.scratch = scratch
        self.owner = uuid.uuid4().hex
        self.name = 'livo-retention-fixture-' + self.owner[:16]
        self.project = 'livo-retention-' + self.owner[:16]
        self.cid = None
        self.creation_attempted = False
        self.sources = [(name, uuid.uuid4()) for name in load_sources()]
        self.tables = [table_name(token) for _, token in self.sources]
        self.unknown_token = uuid.uuid4()
        self.unknown_table = table_name(self.unknown_token)
        self.config_path = scratch / 'policy.json'
        self.status_path = scratch / 'status.json'
        self.lock_path = scratch / 'retention.lock'
        self.inhibit_path = scratch / 'maintenance.inhibit'
        self.last_helper = {}
        self.tests = []
        self.stage = 'initialize'

    def sql(self, sql, database='_supabase'):
        return command(DOCKER + ['exec', '-i', self.cid, 'psql', '-X', '-qAt', '-w',
            '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=sqlstate', '-U', 'postgres',
            '-d', database], input_text=sql, stage='fixture_sql')

    def json_sql(self, sql, database='_supabase'):
        try:
            return json.loads(self.sql(sql, database))
        except ValueError:
            raise FixtureFailure('fixture_sql_json') from None

    def start(self):
        command(DOCKER + ['info', '--format', '{{.ServerVersion}}'], timeout=20,
                stage='docker_daemon')
        command(DOCKER + ['pull', IMAGE], timeout=240, stage='postgres_image_pull')
        self.creation_attempted = True
        self.cid = command(DOCKER + ['run', '-d', '--name', self.name,
            '--label', 'livo.retention-fixture=' + self.owner,
            '--label', 'com.docker.compose.project=' + self.project,
            '--label', 'com.docker.compose.service=db', '--network', 'none',
            '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', IMAGE],
            timeout=120, stage='fixture_container_create').strip()
        if not re.fullmatch(r'[0-9a-f]{64}', self.cid):
            raise FixtureFailure('fixture_container_id')
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            ready = subprocess.run(DOCKER + ['exec', self.cid, 'pg_isready', '-U', 'postgres'],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=10)
            if ready.returncode == 0:
                # Initialization restarts the temporary postmaster once. Require
                # a successful normal database query after pg_isready as well.
                try:
                    if self.sql("SELECT current_setting('listen_addresses');", 'postgres').strip():
                        return
                except FixtureFailure:
                    pass
            time.sleep(0.5)
        raise FixtureFailure('postgres_readiness_timeout')

    def cleanup(self):
        target = self.cid if self.cid and re.fullmatch(r'[0-9a-f]{64}', self.cid) else self.name
        probe = subprocess.run(DOCKER + ['inspect', target], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=20)
        if probe.returncode != 0:
            absent = 'No such object' in probe.stderr or 'No such container' in probe.stderr
            if self.creation_attempted and not absent:
                raise FixtureFailure('fixture_cleanup_unverified')
            return
        items = json.loads(probe.stdout)
        if len(items) != 1:
            raise FixtureFailure('fixture_cleanup_identity')
        item = items[0]
        labels = item.get('Config', {}).get('Labels') or {}
        if labels.get('livo.retention-fixture') != self.owner:
            raise FixtureFailure('fixture_cleanup_ownership')
        cid = item.get('Id', '')
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            raise FixtureFailure('fixture_cleanup_exact_id')
        command(DOCKER + ['rm', '-f', '-v', cid], timeout=45, stage='fixture_cleanup')
        self.cid = None

    def setup(self):
        self.sql('CREATE DATABASE _supabase;', 'postgres')
        self.sql("CREATE TABLE public.example_business (id text PRIMARY KEY, value text);"
                 "INSERT INTO public.example_business VALUES ('business','example-preserve');", 'postgres')
        parts = [
            'CREATE SCHEMA _analytics;',
            'CREATE TABLE _analytics.sources (id integer PRIMARY KEY, name text NOT NULL, token uuid NOT NULL);',
            'CREATE TABLE _analytics.backends (id integer PRIMARY KEY, config jsonb NOT NULL);',
            "INSERT INTO _analytics.backends VALUES (1,'{\"fixture\":\"example-preserve\"}');",
            'CREATE TABLE public.example_business (id text PRIMARY KEY, value text);',
            "INSERT INTO public.example_business VALUES ('business','example-preserve');",
            'CREATE TABLE public.example_slack (id text PRIMARY KEY, value text);',
            "INSERT INTO public.example_slack VALUES ('slack','example-preserve');",
        ]
        for index, (name, token) in enumerate(self.sources + [('example.unknown.logs', self.unknown_token)], 1):
            rel = relation(table_name(token))
            parts.append('INSERT INTO _analytics.sources VALUES (' + str(index) + ',' + quoted(name) + ',' + quoted(token) + '::uuid);')
            parts.append('CREATE TABLE ' + rel + ' (id text PRIMARY KEY, body jsonb, event_message text, timestamp TIMESTAMP WITHOUT TIME ZONE);')
            parts.append('INSERT INTO ' + rel + " VALUES "
                "('old','{\"fixture\":\"example\"}','Example old event',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '8 days'),"
                "('recent','{\"fixture\":\"example\"}','Example recent event',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '1 day'),"
                "('null','{\"fixture\":\"example\"}','Example null time',NULL),"
                "('future','{\"fixture\":\"example\"}','Example future event',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')+INTERVAL '1 day');")
        self.sql('\n'.join(parts))

    def helper(self, *args, expected=('preview',)):
        result = subprocess.run([sys.executable, '-B', str(HELPER), *args],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180, check=False)
        try:
            payload = json.loads(result.stdout)
        except ValueError:
            raise FixtureFailure('helper_stdout_json') from None
        return self.check_helper_result(payload, result.returncode, expected)

    def check_helper_result(self, payload, returncode, expected):
        self.last_helper = {key: payload.get(key) for key in (
            'status', 'reason', 'dml_attempted', 'operation', 'returncode',
            'stderr_sha256', 'result_unknown')}
        if payload.get('status') not in expected:
            raise FixtureFailure('unexpected_helper_status')
        valid_code = 0 if payload['status'] in ('preview', 'completed', 'bound_disabled') else 2
        if returncode != valid_code:
            raise FixtureFailure('helper_exit_status_contract')
        if payload.get('status_write_failed'):
            raise FixtureFailure('helper_status_write_failed')
        return payload

    def invoke_transport_fault(self, fault):
        # Use the production CLI and real Docker/PG metadata and transaction.
        # Only the disposable fixture transport response is deliberately lost;
        # no fixture-only fault switch is added to the production helper.
        spec = importlib.util.spec_from_file_location('livo_retention_fault_fixture', HELPER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        original = module.Docker.json_sql

        def faulty_sql(client, sql, operation='postgres_metadata', timeout=30):
            if operation == 'delete_expired_batch':
                if fault == 'sql_failure':
                    # Actual SQL failure in the real transaction, not a fake
                    # metadata response. Treat unsuccessful SQL ACKs as unknown.
                    return original(client, sql.replace('BEGIN;', 'BEGIN; SELECT 1/0;', 1), operation, timeout=timeout)
                original(client, sql, operation, timeout=timeout)
                if fault == 'lost_commit_ack':
                    raise module.Refused('command_timeout', operation=operation)
                if fault == 'invalid_commit_ack':
                    return {'deleted_rows': 'unusable-ack'}
                raise FixtureFailure('unknown_fixture_fault')
            return original(client, sql, operation, timeout=timeout)

        with mock.patch.object(module.Docker, 'json_sql', new=faulty_sql), contextlib.redirect_stdout(io.StringIO()) as output:
            probe = module.Docker(json_file(self.config_path))
            probe.inspect()
            self.expect(probe.json_sql("SELECT jsonb_build_object('fixture',true);") == {'fixture': True},
                'fault_wrapper_default_operation_contract')
            code = module.main(['--scheduled', '--config', str(self.config_path)])
        return self.check_helper_result(json.loads(output.getvalue()), code, ('partial',))

    def invoke(self, *args, expected=('preview',)):
        return self.helper(*args, '--config', str(self.config_path), expected=expected)

    def save(self, **changes):
        config = json_file(self.config_path)
        config.update(changes)
        write_config(self.config_path, config)
        return config

    def old_count(self):
        query = ' UNION ALL '.join('SELECT count(*)::bigint AS n FROM ' + relation(name)
            + " WHERE timestamp < (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '7 days'" for name in self.tables)
        return int(self.sql('SELECT sum(n) FROM (' + query + ') q;').strip())

    def seed_old(self):
        self.sql('\n'.join('INSERT INTO ' + relation(name)
            + " VALUES ('old-extra','{}','Example old event',(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '8 days')"
              ' ON CONFLICT (id) DO UPDATE SET timestamp=EXCLUDED.timestamp;' for name in self.tables))

    def protected(self):
        expressions = []
        for name in self.tables:
            expressions.append('SELECT ' + quoted(name) + ' AS label, md5(coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY id)::text FROM '
                + relation(name) + " t WHERE timestamp IS NULL OR timestamp >= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')-INTERVAL '7 days'),'[]')) AS digest")
        for label, rel, order in (
            ('sources', '_analytics.sources', 'id'), ('backends', '_analytics.backends', 'id'),
            ('business', 'public.example_business', 'id'), ('slack', 'public.example_slack', 'id'),
            ('unknown', relation(self.unknown_table), 'id'),
        ):
            expressions.append('SELECT ' + quoted(label) + ", md5(coalesce((SELECT jsonb_agg(to_jsonb(t) ORDER BY " + order + ')::text FROM ' + rel + " t),'[]'))")
        result = self.json_sql('SELECT jsonb_object_agg(label,digest) FROM (' + ' UNION ALL '.join(expressions) + ') q;')
        result['other_database_business'] = self.sql("SELECT md5(jsonb_agg(to_jsonb(t) ORDER BY id)::text) FROM public.example_business t;", 'postgres').strip()
        return result

    def expect(self, condition, reason):
        if not condition:
            raise FixtureFailure(reason)

    def refusal_case(self, name, *, reason=None, mutate=None, restore=None):
        self.stage = name
        old = self.old_count()
        protected = self.protected()
        previous_success = json_file(self.status_path).get('last_success_at_utc')
        try:
            if mutate:
                mutate()
            result = self.invoke('run', '--apply', expected=('refused',))
            self.expect(not result.get('dml_attempted'), 'refusal_attempted_dml')
            if reason:
                self.expect(result.get('reason') == reason, 'unexpected_refusal_reason')
            self.expect(result.get('last_success_at_utc') == previous_success, 'refusal_lost_last_success')
        finally:
            if restore:
                restore()
        self.expect(self.old_count() == old, 'refusal_changed_expired_rows')
        self.expect(self.protected() == protected, 'refusal_changed_protected_data')
        self.tests.append(name)

    def ordered_cloudflare_batches(self, config):
        self.stage = 'ordered_cloudflare_batches'
        spec = importlib.util.spec_from_file_location('livo_retention_ordered_fixture', HELPER)
        helper = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(helper)
        item = next(row for row in config['binding']['sources'] if row['source_name'] == 'cloudflare.logs.prod')
        rel = relation(item['table_name'])
        cutoff = '2000-01-04T00:00:00'
        ids = ['order-locked', 'order-next', 'order-other', 'order-boundary', 'order-future', 'order-null']
        # Reverse physical insertion order so LIMIT alone cannot satisfy oldest-first.
        self.sql('INSERT INTO ' + rel + " (id,timestamp) VALUES "
            "('order-other','2000-01-03'),('order-next','2000-01-02'),('order-locked','2000-01-01'),"
            "('order-boundary','2000-01-04'),('order-future','2000-01-05'),('order-null',NULL);")
        locker = subprocess.Popen(DOCKER + ['exec', '-i', self.cid, 'psql', '-X', '-qAt', '-w',
            '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', '_supabase'], stdin=subprocess.PIPE,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, encoding='utf-8')
        try:
            locker.stdin.write("SET idle_in_transaction_session_timeout=15000; BEGIN; SELECT 'locked' FROM "
                + rel + " WHERE id='order-locked' FOR UPDATE;\n")
            locker.stdin.flush()
            readable, _, _ = select.select([locker.stdout], [], [], 10)
            self.expect(bool(readable) and locker.stdout.readline().strip() == 'locked', 'ordered_fixture_lock_unavailable')
            result = self.json_sql(helper.delete_batch_sql(config, item, cutoff, 1))
            self.expect(result == {'deleted_rows': 1}, 'ordered_batch_limit')
            remaining = self.json_sql('SELECT jsonb_agg(id ORDER BY id) FROM ' + rel
                + " WHERE id LIKE 'order-%';")
            self.expect('order-locked' in remaining and 'order-next' not in remaining
                and 'order-other' in remaining, 'ordered_oldest_unlocked_row_not_selected')
        finally:
            try:
                locker.stdin.write('ROLLBACK;\n\\q\n')
                locker.stdin.flush()
                locker.communicate(timeout=10)
            except (BrokenPipeError, OSError, subprocess.TimeoutExpired):
                locker.kill()
                locker.communicate(timeout=5)
        self.expect(locker.returncode == 0, 'ordered_fixture_lock_cleanup')
        result = self.json_sql(helper.delete_batch_sql(config, item, cutoff, 1))
        self.expect(result == {'deleted_rows': 1}, 'ordered_second_batch_limit')
        self.expect(self.sql('SELECT count(*) FROM ' + rel + " WHERE id='order-locked';").strip() == '0',
                    'ordered_oldest_row_not_selected_after_unlock')
        result = self.json_sql(helper.delete_batch_sql(config, item, cutoff, 1000))
        self.expect(result == {'deleted_rows': 1}, 'ordered_remaining_expired_count')
        remaining = self.json_sql('SELECT jsonb_agg(id ORDER BY id) FROM ' + rel + " WHERE id LIKE 'order-%';")
        self.expect(remaining == ['order-boundary', 'order-future', 'order-null'], 'ordered_cutoff_or_null_changed')
        self.sql('DELETE FROM ' + rel + ' WHERE id IN (' + ','.join(quoted(value) for value in ids) + ');')
        self.tests.append('ordered_cf_oldest_unlocked_bounded_cutoff')

    def exercise(self):
        self.stage = 'bind_disabled'
        result = self.helper('bind', '--config', str(self.config_path), '--container', self.name,
            '--project', self.project, '--db-user', 'postgres', '--status-path', str(self.status_path),
            '--lock-path', str(self.lock_path), '--maintenance-inhibit-path', str(self.inhibit_path),
            expected=('bound_disabled',))
        config = json_file(self.config_path)
        self.expect(config['enabled'] is False, 'bind_not_disabled')
        self.expect(config['compose_service'] == 'db' and config['database'] == '_supabase', 'binding_target_contract')
        self.expect(stat.S_IMODE(self.config_path.stat().st_mode) == 0o600 and self.config_path.stat().st_uid == 0, 'binding_permissions')
        self.tests.append('bind_disabled_root_owned')
        self.ordered_cloudflare_batches(config)
        protected = self.protected()
        before = self.old_count()
        self.stage = 'default_preview'
        result = self.invoke()
        self.expect(result.get('dml_attempted') is False and self.old_count() == before, 'default_preview_mutated')
        self.expect(self.protected() == protected, 'preview_changed_protected_data')
        self.tests.append('default_preview_no_dml')
        self.stage = 'disabled_scheduled'
        result = self.invoke('--scheduled', expected=('refused',))
        self.expect(result.get('reason') == 'disabled' and not result.get('dml_attempted'), 'disabled_scheduled_contract')
        self.expect(self.old_count() == before and self.protected() == protected, 'disabled_scheduled_mutated')
        self.tests.append('disabled_scheduled_no_dml')
        result = self.invoke('run', '--apply', expected=('refused',))
        self.expect(result.get('reason') == 'disabled' and self.old_count() == before, 'disabled_apply_mutated')
        self.tests.append('disabled_explicit_apply_no_dml')
        self.save(enabled=True, batch_rows=1, max_rows_per_run=2)
        self.stage = 'bounded_partial'
        result = self.invoke('run', '--apply', expected=('partial',))
        self.expect(result.get('deleted_rows') == 2 and result.get('max_batch_rows') == 1 and result.get('expired_remaining_bounded', 0) > 0, 'row_budget_not_partial')
        self.expect(self.old_count() == before - 2 and self.protected() == protected, 'bounded_partial_scope')
        self.expect(not result.get('last_success_at_utc'), 'partial_claimed_first_success')
        self.tests.append('bounded_partial_not_completed')
        self.save(batch_rows=1000, max_rows_per_run=1000000)
        self.stage = 'scheduled_complete'
        result = self.invoke('--scheduled', expected=('completed',))
        self.expect(self.old_count() == 0 and self.protected() == protected, 'scheduled_retained_scope')
        self.expect(result.get('last_success_at_utc') == result.get('completed_at_utc') and result.get('physical_compaction_performed') is False, 'completed_success_contract')
        self.tests.append('enabled_scheduled_only_expired')
        first_success = result['last_success_at_utc']
        self.stage = 'completed_preview'
        result = self.invoke()
        self.expect(result.get('last_success_at_utc') == first_success, 'preview_lost_last_success')
        self.tests.append('preview_preserves_last_success')
        self.seed_old()
        self.save(batch_rows=1, max_rows_per_run=2)
        self.stage = 'partial_after_success'
        result = self.invoke('run', '--apply', expected=('partial',))
        self.expect(result.get('last_success_at_utc') == first_success, 'partial_lost_last_success')
        self.expect(result.get('deleted_rows') == 2 and self.protected() == protected, 'partial_after_success_scope')
        self.tests.append('partial_preserves_last_success')
        self.save(batch_rows=1000, max_rows_per_run=1000000)
        self.refusal_case('maintenance_inhibit', reason='maintenance_inhibited',
            mutate=lambda: self.inhibit_path.touch(mode=0o600), restore=lambda: self.inhibit_path.unlink(missing_ok=True))
        import fcntl
        with open(self.lock_path, 'a', encoding='utf-8') as lock:
            os.chmod(self.lock_path, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            status_bytes = self.status_path.read_bytes()
            self.refusal_case('single_instance_flock')
            self.expect(self.status_path.read_bytes() == status_bytes, 'lock_failure_overwrote_status')
            fcntl.flock(lock, fcntl.LOCK_UN)
        config = json_file(self.config_path)
        self.refusal_case('insufficient_free_space', reason='insufficient_free_space',
            mutate=lambda: self.save(min_free_bytes=2**62), restore=lambda: write_config(self.config_path, config))
        bad = copy.deepcopy(config)
        bad['binding']['cluster_id'] = '0'
        self.refusal_case('cluster_identity_drift', reason='retention_binding_changed',
            mutate=lambda: write_config(self.config_path, bad), restore=lambda: write_config(self.config_path, config))
        self.refusal_case('compose_label_drift', reason='container_identity_or_readiness_changed',
            mutate=lambda: self.save(compose_project=self.project + '-wrong'), restore=lambda: write_config(self.config_path, config))
        first_source = self.sources[0][0]
        self.refusal_case('source_name_drift',
            mutate=lambda: self.sql('UPDATE _analytics.sources SET name=\'example.renamed.logs\' WHERE name=' + quoted(first_source) + ';'),
            restore=lambda: self.sql('UPDATE _analytics.sources SET name=' + quoted(first_source) + " WHERE name='example.renamed.logs';"))
        target = self.tables[0]
        saved = target + '_original'
        self.refusal_case('table_oid_drift', reason='retention_binding_changed',
            mutate=lambda: self.sql('ALTER TABLE ' + relation(target) + ' RENAME TO "' + saved + '";CREATE TABLE ' + relation(target) + ' (LIKE "_analytics"."' + saved + '" INCLUDING ALL);INSERT INTO ' + relation(target) + ' SELECT * FROM "_analytics"."' + saved + '";'),
            restore=lambda: self.sql('DROP TABLE ' + relation(target) + ';ALTER TABLE "_analytics"."' + saved + '" RENAME TO "' + target + '";'))
        self.refusal_case('delete_rewrite_side_effect_refused', reason='unsupported_source_schema',
            mutate=lambda: self.sql('CREATE RULE example_unsafe_delete AS ON DELETE TO ' + relation(target) + ' DO ALSO DELETE FROM public.example_business;'),
            restore=lambda: self.sql('DROP RULE example_unsafe_delete ON ' + relation(target) + ';'))
        self.refusal_case('user_trigger_side_effect_refused', reason='unsupported_source_schema',
            mutate=lambda: self.sql("CREATE FUNCTION public.example_unsafe_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN DELETE FROM public.example_business; RETURN OLD; END;$$;CREATE TRIGGER example_unsafe BEFORE DELETE ON " + relation(target) + ' FOR EACH ROW EXECUTE FUNCTION public.example_unsafe_trigger();'),
            restore=lambda: self.sql('DROP TRIGGER example_unsafe ON ' + relation(target) + ';DROP FUNCTION public.example_unsafe_trigger();'))
        self.refusal_case('foreign_key_side_effect_refused', reason='unsupported_source_schema',
            mutate=lambda: self.sql('CREATE TABLE public.example_fk (id text REFERENCES ' + relation(target) + "(id) ON DELETE CASCADE);INSERT INTO public.example_fk VALUES ('recent');"),
            restore=lambda: self.sql('DROP TABLE public.example_fk;'))
        self.refusal_case('inheritance_refused', reason='unsupported_source_schema',
            mutate=lambda: self.sql('CREATE TABLE _analytics.example_child () INHERITS (' + relation(target) + ');'),
            restore=lambda: self.sql('DROP TABLE _analytics.example_child;'))
        self.stage = 'explicit_complete'
        result = self.invoke('run', '--apply', expected=('completed',))
        self.expect(self.old_count() == 0 and self.protected() == protected, 'explicit_completion_scope')
        self.expect(result.get('last_success_at_utc') == result.get('completed_at_utc') and result['last_success_at_utc'] != first_success, 'last_success_not_updated')
        self.tests.append('enabled_explicit_only_expired')


        self.seed_old()
        before = self.old_count()
        self.save(batch_rows=1, max_wal_growth_bytes=1)
        self.stage = 'real_ack_then_wal_guard'
        result = self.invoke('--scheduled', expected=('partial',))
        self.expect(result.get('reason') == 'wal_growth_gate', 'normal_guard_reason')
        self.expect(result.get('deleted_rows') == 1 and result.get('batches') == 1, 'real_ack_count')
        self.expect(not result.get('result_unknown') and not result.get('result_unknown_until_readback')
            and result.get('pending_batch') is None, 'acked_guard_falsely_unknown')
        self.expect(self.old_count() == before - 1 and self.protected() == protected, 'acked_guard_scope')
        self.tests.append('real_commit_ack_then_normal_wal_guard_known_partial')
        self.save(max_wal_growth_bytes=512 * 1024**2, max_rows_per_run=2)
        self.stage = 'known_partial_next_bounded_pass'
        result = self.invoke('--scheduled', expected=('partial',))
        self.expect(result.get('deleted_rows') == 2 and not result.get('result_unknown'), 'known_partial_not_resumable')
        self.expect(self.old_count() == before - 3 and self.protected() == protected, 'resumed_partial_scope')
        self.tests.append('known_partial_allows_next_bounded_pass')

        self.stage = 'prelock_error_preserves_known_ack_evidence'
        status_bytes = self.status_path.read_bytes()
        missing = self.helper('--status-path', str(self.status_path), expected=('refused',))
        self.expect(missing.get('reason') == 'config_missing' and missing.get('status_preserved'), 'missing_config_contract')
        self.expect(self.status_path.read_bytes() == status_bytes, 'missing_config_overwrote_status')
        invalid_config = self.scratch / 'invalid-policy.json'
        write_config(invalid_config, {'fixture': 'invalid'})
        invalid_config.write_text('{', encoding='utf-8')
        invalid = self.helper('--config', str(invalid_config), '--status-path', str(self.status_path), expected=('refused',))
        self.expect(invalid.get('reason') == 'invalid_config_json' and invalid.get('status_preserved'), 'invalid_config_contract')
        self.expect(self.status_path.read_bytes() == status_bytes, 'invalid_config_overwrote_status')
        self.tests.append('prelock_cli_and_config_errors_preserve_actual_status_bytes')

        self.stage = 'external_unknown_marker'
        marker = self.status_path.with_name('manual-result-unknown.json')
        write_config(marker, {'fixture': 'unresolved-operation'})
        status_bytes, marker_bytes = self.status_path.read_bytes(), marker.read_bytes()
        for args in ((), ('--scheduled',)):
            result = self.invoke(*args, expected=('refused',))
            self.expect(result.get('reason') == 'unresolved_previous_result'
                and result.get('status_preserved') and not result.get('dml_attempted'), 'marker_not_sticky')
            self.expect(self.status_path.read_bytes() == status_bytes and marker.read_bytes() == marker_bytes, 'marker_evidence_overwritten')
        marker.unlink()  # Only this disposable fixture's deliberately seeded marker.
        self.tests.append('external_unknown_marker_blocks_preview_and_scheduled_without_overwrite')

        for fault in ('lost_commit_ack', 'invalid_commit_ack', 'sql_failure'):
            self.stage = fault
            self.seed_old()
            before = self.old_count()
            result = self.invoke_transport_fault(fault)
            expected_deleted = 0 if fault == 'sql_failure' else 1
            self.expect(self.old_count() == before - expected_deleted, 'fault_actual_transaction_scope')
            self.expect(self.protected() == protected and result.get('deleted_rows') == 0, 'fault_acked_count_or_scope')
            self.expect(result.get('result_unknown') and result.get('result_unknown_until_readback')
                and result.get('pending_batch') is not None, 'unacked_sql_not_unknown')
            status_bytes = self.status_path.read_bytes()
            for args in ((), ('--scheduled',)):
                refused = self.invoke(*args, expected=('refused',))
                self.expect(refused.get('reason') == 'unresolved_previous_result'
                    and refused.get('status_preserved') and not refused.get('dml_attempted'), 'unknown_not_sticky')
                self.expect(self.status_path.read_bytes() == status_bytes, 'unknown_evidence_overwritten')
            self.expect(self.old_count() == before - expected_deleted and self.protected() == protected, 'unknown_retry_mutated')
            self.tests.append('real_transaction_' + fault + '_unknown_and_preview_preserves_evidence')
            # Explicit test-only evidence archive after count-only readback of
            # the owned fixture; production CLI has no auto-clear/force option.
            self.status_path.rename(self.scratch / (fault + '.status.json'))


def root_main():
    summary = {'passed': False, 'fixture': 'postgresql-15.8', 'tests': [], 'cleanup_verified': False}
    fixture = None
    try:
        with tempfile.TemporaryDirectory(prefix='livo-retention-pg-', dir='/tmp') as directory:
            scratch = Path(directory)
            os.chmod(scratch, 0o700)
            if scratch.stat().st_uid != 0:
                raise FixtureFailure('fixture_directory_not_root_owned')
            fixture = Fixture(scratch)
            try:
                fixture.start()
                fixture.setup()
                fixture.exercise()
                summary['passed'] = True
            finally:
                fixture.cleanup()
                summary['cleanup_verified'] = True
    except BaseException as error:
        summary['passed'] = False
        summary['reason'] = str(error) if isinstance(error, FixtureFailure) else type(error).__name__
    if fixture:
        summary['tests'] = fixture.tests
        summary['stage'] = fixture.stage
        if not summary['passed']:
            summary['helper'] = fixture.last_helper
    print(json.dumps(summary, sort_keys=True))
    return 0 if summary['passed'] else 1


def main():
    if not hasattr(os, 'geteuid'):
        print(json.dumps({'passed': False, 'reason': 'linux_root_required'}))
        return 1
    if os.geteuid() != 0:
        # Preserve the helper's real root/ownership checks. Only the disposable
        # fixture driver is elevated; no production configuration is involved.
        try:
            result = subprocess.run(['sudo', '-n', 'python3', '-B', str(Path(__file__).resolve())],
                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=900)
            payload = json.loads(result.stdout)
            print(json.dumps(payload, sort_keys=True))
            return result.returncode
        except (OSError, subprocess.TimeoutExpired, ValueError):
            print(json.dumps({'passed': False, 'reason': 'noninteractive_root_reexec_failed'}))
            return 1
    return root_main()


if __name__ == '__main__':
    sys.exit(main())
