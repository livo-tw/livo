#!/usr/bin/env python3
"""Render all self-host Compose profiles and test the actual Vector transforms.

Only Python's standard library and the Docker CLI are required. --config-only
uses no daemon. Native tests use isolated, exactly-owned disposable containers;
never Docker's log socket or the production HTTP sinks. All fixtures are fictional.
"""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

APP_ROOT = Path(__file__).resolve().parents[1]
VECTOR_IMAGE = 'timberio/vector:0.53.0-alpine'
LOGGING = {'driver': 'json-file', 'options': {'max-size': '10m', 'max-file': '3', 'compress': 'true'}}
EXPECTED_SERVICES = {'studio', 'kong', 'auth', 'rest', 'realtime', 'storage', 'imgproxy',
                     'meta', 'functions', 'livo-scheduler', 'analytics', 'db', 'vector',
                     'supavisor', 'knowledge-processor', 'livo-frontend',
                     'livo-slack-delivery', 'livo-slack-socket'}


class CheckFailure(RuntimeError):
    pass


def run(args, *, cwd=None, env=None, input_text=None, timeout=120):
    result = subprocess.run(args, cwd=cwd, env=env, input=input_text, text=True,
                            encoding='utf-8', errors='replace', stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, timeout=timeout, check=False)
    if result.returncode:
        # This script passes only synthetic config to Docker. Limit diagnostic output.
        detail = (result.stderr or result.stdout)[-5000:]
        raise CheckFailure(f'{args[0]} command failed ({result.returncode}):\n{detail}')
    return result.stdout


def load_json(text, label):
    try:
        return json.loads(text)
    except ValueError as error:
        raise CheckFailure(label + ' did not return JSON') from error


def compose_render_checks(args, scratch):
    source = scratch / 'compose'
    source.mkdir()
    paths = [args.compose_dir / 'docker-compose.yml', args.frontend_compose]
    if args.knowledge_compose.exists():
        paths.append(args.knowledge_compose)
    else:
        raise CheckFailure('knowledge-processor Compose fragment is missing')
    copies = []
    variables = set()
    for i, path in enumerate(paths):
        content = path.read_text(encoding='utf-8-sig')
        variables.update(re.findall(r'\$\{([A-Za-z_][A-Za-z0-9_]*)', content))
        target = source / ('compose-' + str(i) + '.yml')
        target.write_text(content, encoding='utf-8')
        copies.append(target)
    # Never read a checkout's .env. Override every referenced variable with a
    # synthetic value, including the process environment's higher-precedence keys.
    fixture = {name: 'example-only' for name in variables}
    fixture.update({'POSTGRES_PORT': '5432', 'KONG_HTTP_PORT': '8000',
                    'KONG_HTTPS_PORT': '8443', 'LIVO_FRONTEND_PORT': '3000',
                    'POSTGRES_HOST': 'db', 'POSTGRES_DB': 'postgres',
                    'DOCKER_SOCKET_LOCATION': '/var/run/docker.sock',
                    'PWD': str(source), 'COMPOSE_PROFILES': '*',
                    'KNOWLEDGE_PROCESSOR_TOKEN': 'example-only-processor-token'})
    env_path = scratch / 'synthetic-compose.env'
    env_path.write_text('\n'.join(name + '=' + value for name, value in sorted(fixture.items())) + '\n', encoding='utf-8')
    environment = dict(os.environ)
    environment.update(fixture)
    command = ['docker', 'compose', '--profile', '*', '--env-file', str(env_path)]
    def render(files):
        cli = list(command)
        for file in files:
            cli.extend(['-f', str(file)])
        return load_json(run(cli + ['config', '--format', 'json'], cwd=source,
                             env=environment), 'docker compose config')
    models = {'base': render([copies[0]]),
              'combined': render(copies[:2]), 'knowledge_fragment': render([copies[2]])}
    for label, model in models.items():
        services = model.get('services') or {}
        if not services:
            raise CheckFailure(label + ' has no services')
        for name, service in services.items():
            if service.get('logging') != LOGGING:
                raise CheckFailure(label + ': logging cap differs for service ' + name)
    combined = models['combined']['services']
    if set(combined) != EXPECTED_SERVICES:
        raise CheckFailure('combined Compose service set differs from the 18-service contract')
    if combined['vector'].get('image') != VECTOR_IMAGE:
        raise CheckFailure('Vector image must remain pinned to ' + VECTOR_IMAGE)
    if set(models['knowledge_fragment']['services']) != {'knowledge-processor'}:
        raise CheckFailure('standalone knowledge fragment service set changed')
    return {'profiles': 'all', 'combined_services': len(combined),
            'base_services': len(models['base']['services']), 'standalone_fragment': True}


def access(method, path, status=200, request=None):
    request = request if request is not None else f'{method} {path} HTTP/1.1'
    return (f'192.0.2.10 - - [03/Nov/2026:00:00:00 +0000] "{request}" '
            f'{status} 123 "https://example.com/" "ExampleAgent/1.0"')


def cases():
    rows = []
    def add(name, message, keep, container='supabase-kong', check=None):
        rows.append({'name': name, 'keep': keep, 'check': check,
                     'event': {'case_id': name, 'container_name': container,
                               'message': message, 'timestamp': '2026-11-03T00:00:00Z'}})
    for method in ('GET', 'HEAD'):
        for path in ('/health', '/healthz', '/ready', '/auth/v1/health',
                     '/storage/v1/status', '/realtime/v1/health', '/rest/v1/field_locks'):
            add('drop-' + method.lower() + '-' + path.strip('/').replace('/', '-'),
                access(method, path), False)
    add('drop-query-and-trailing-slashes', access('GET', '/rest/v1/field_locks///?select=*'), False)
    add('drop-health-query-head-204', access('HEAD', '/health/?probe=example', 204), False)
    for status in (199, 301, 400, 401, 403, 404, 429, 500, 503):
        add('retain-poll-status-' + str(status), access('GET', '/rest/v1/field_locks', status), True)
    for method in ('POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'):
        add('retain-write-' + method.lower(), access(method, '/rest/v1/field_locks'), True)
    for name, path in (
        ('business', '/rest/v1/tasks?select=*'), ('auth', '/auth/v1/user'),
        ('auth-token', '/auth/v1/token'), ('rpc', '/rest/v1/rpc/health'),
        ('health-prefix', '/healthcheck'), ('health-suffix', '/health/details'),
        ('poll-suffix', '/rest/v1/field_locks_extra'),
        ('poll-child', '/rest/v1/field_locks/example'),
        ('encoded-path', '/rest/v1/%66ield_locks'),
        ('query-containing-health', '/rest/v1/tasks?note=/health'),
    ):
        add('retain-' + name, access('GET', path), True)
    add('retain-auth-post', access('POST', '/auth/v1/token'), True)
    add('retain-request-without-protocol', access('GET', '/health', request='GET /health'), True)
    error = ('2026/11/03 00:00:00 [error] 1#1: *1 connect() failed (111: Connection refused) '
             'while connecting to upstream, client: 192.0.2.10, server: example.com, '
             'request: "GET /rest/v1/field_locks?select=* HTTP/1.1", '
             'upstream: "http://198.51.100.2:8000/rest/v1/field_locks", host: "example.com"')
    add('retain-error-despite-synthetic-200', error, True,
        check='assert_eq!(.metadata.response.status_code, 200)\nassert_eq!(.severity, "error")')
    add('retain-unknown-startup-once', 'Example service startup message', True,
        check='assert_eq!(.metadata.log_parser, "unparsed")')
    add('retain-malformed-access-once', '192.0.2.10 "GET /health" invalid-status', True,
        check='assert_eq!(.metadata.log_parser, "unparsed")')
    add('retain-object-message-once', {'example': 'structured unknown message'}, True,
        check='assert_eq!(.metadata.log_parser, "unparsed")')
    add('retain-realtime-health-error', '12:00:00.000 [error] GET /health failed with 503',
        True, container='realtime-dev.supabase-realtime')
    add('retain-auth-health-error', json.dumps({'time': '2026-11-03T00:00:00Z',
        'level': 'error', 'msg': 'GET /health failed', 'status': 500}),
        True, container='supabase-auth')
    return rows


def isolated_vector_configs(vector_path, scratch, rows):
    source = vector_path.read_text(encoding='utf-8-sig').replace('\r\n', '\n')
    if source.count('\ntransforms:\n') != 1 or source.count('\nsinks:\n') != 1:
        raise CheckFailure('Vector source section structure changed')
    transforms = source.split('\ntransforms:\n', 1)[1].split('\nsinks:\n', 1)[0]
    sink_section = source.split('\nsinks:\n', 1)[1]
    terminals = []
    in_inputs = False
    for line in sink_section.splitlines():
        if re.match(r'^    inputs:\s*$', line):
            in_inputs = True
        elif in_inputs:
            match = re.match(r'^      - ([A-Za-z0-9_.-]+)\s*$', line)
            if match:
                terminals.append(match.group(1))
            elif line.strip():
                in_inputs = False
    if not terminals or len(terminals) != len(set(terminals)):
        raise CheckFailure('production sink inputs must be present and unique')
    if '${' in transforms:
        raise CheckFailure('isolated transforms must not require deployment environment values')
    capture = ('  test_capture:\n    type: remap\n    inputs: ' + json.dumps(terminals)
               + '\n    source: "."\n')
    prefix = ('data_dir: /tmp/vector-test\n'
              'sources:\n  docker_host:\n    type: stdin\n'
              '    decoding:\n      codec: json\n'
              'transforms:\n' + transforms + capture +
              'sinks:\n  test_console:\n    type: console\n'
              '    inputs: [test_capture]\n    encoding:\n      codec: json\n')
    tests = []
    for row in rows:
        test = {'name': row['name'], 'inputs': [{'insert_at': 'project_logs',
                'type': 'log', 'log_fields': row['event']}]}
        if row['keep']:
            check = 'assert_eq!(.case_id, ' + json.dumps(row['name']) + ')'
            if row['check']:
                check += '\n' + row['check']
            test['outputs'] = [{'extract_from': 'test_capture',
                                'conditions': [{'type': 'vrl', 'source': check}]}]
        else:
            test['no_outputs_from'] = ['test_capture']
        tests.append(test)
    unit_path = scratch / 'vector-unit.yaml'
    stream_path = scratch / 'vector-stream.yaml'
    unit_path.write_text(prefix + 'tests: ' + json.dumps(tests) + '\n', encoding='utf-8')
    stream_path.write_text(prefix, encoding='utf-8')
    # Vector's image uses a different, unprivileged UID from the CI runner.
    # Only these synthetic configs are made readable; they contain no sinks,
    # Docker socket source, deployment values or credentials.
    unit_path.chmod(0o644)
    stream_path.chmod(0o644)
    return unit_path, stream_path


def native_container(scratch, command, *, input_text=None):
    owner = uuid.uuid4().hex
    name = 'livo-vector-log-test-' + owner[:12]
    cid = None
    mount = 'type=bind,src=' + str(scratch.resolve()) + ',dst=/fixtures,readonly'
    create = ['docker', 'create', '--name', name, '--label', 'livo.log-policy-test=' + owner,
              '--network', 'none', '--read-only', '--cap-drop', 'ALL',
              '--security-opt', 'no-new-privileges', '--tmpfs',
              '/tmp:rw,nosuid,nodev,size=64m,mode=1777', '--mount', mount,
              '--env', 'VECTOR_LOG=warn']
    if input_text is not None:
        create.append('-i')
    try:
        cid = run(create + [VECTOR_IMAGE] + command, timeout=180).strip()
        if not re.fullmatch(r'[0-9a-f]{64}', cid):
            raise CheckFailure('Docker did not return a precise test container ID')
        start = ['docker', 'start', '--attach']
        if input_text is not None:
            start.append('--interactive')
        return run(start + [cid], input_text=input_text, timeout=120)
    finally:
        # A failed create can still leave a named container. Inspect that exact
        # name, prove our unique ownership label, then remove only its full ID.
        target = cid if cid and re.fullmatch(r'[0-9a-f]{64}', cid) else name
        inspect = subprocess.run(['docker', 'inspect', target], text=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20, check=False)
        if inspect.returncode == 0:
            metadata = load_json(inspect.stdout, 'test container inspect')
            if len(metadata) != 1 or metadata[0].get('Config', {}).get('Labels', {}).get('livo.log-policy-test') != owner:
                raise CheckFailure('refusing cleanup: test container ownership mismatch')
            exact_id = metadata[0]['Id']
            if not re.fullmatch(r'[0-9a-f]{64}', exact_id):
                raise CheckFailure('refusing cleanup: non-exact container ID')
            run(['docker', 'rm', '--force', exact_id], timeout=30)
        elif cid:
            raise CheckFailure('test container cleanup could not be verified')


def native_vector_checks(args, scratch):
    run(['docker', 'info', '--format', '{{.ServerVersion}}'], timeout=20)
    # This is a test dependency only; no service or Docker Desktop is started.
    run(['docker', 'pull', VECTOR_IMAGE], timeout=240)
    rows = cases()
    # Keep the outer scratch/config directory private. Bind-mount only this
    # synthetic fixture child directory, readable by Vector's non-root UID.
    fixtures = scratch / 'vector-fixtures'
    fixtures.mkdir(mode=0o755)
    fixtures.chmod(0o755)
    unit_path, stream_path = isolated_vector_configs(args.vector_config, fixtures, rows)
    native_container(fixtures, ['test', '/fixtures/' + unit_path.name])
    events = ''.join(json.dumps(row['event']) + '\n' for row in rows)
    stdout = native_container(fixtures, ['--config', '/fixtures/' + stream_path.name], input_text=events)
    counts = Counter()
    for line in stdout.splitlines():
        if not line.strip():
            continue
        event = load_json(line, 'native Vector console')
        name = event.get('case_id')
        if name not in {row['name'] for row in rows}:
            raise CheckFailure('native Vector emitted an unexpected event')
        counts[name] += 1
    for row in rows:
        expected = 1 if row['keep'] else 0
        if counts[row['name']] != expected:
            raise CheckFailure(f"native Vector {row['name']}: expected {expected} output, got {counts[row['name']]}")
    return {'image': VECTOR_IMAGE, 'native_unit_cases': len(rows),
            'native_exactly_once_cases': len(rows),
            'retained': sum(row['keep'] for row in rows),
            'dropped': sum(not row['keep'] for row in rows)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config-only', action='store_true')
    parser.add_argument('--compose-dir', type=Path, default=APP_ROOT / 'docker')
    parser.add_argument('--frontend-compose', type=Path)
    parser.add_argument('--knowledge-compose', type=Path)
    parser.add_argument('--vector-config', type=Path)
    args = parser.parse_args()
    packaged_frontend = args.compose_dir / 'compose.frontend.yml'
    args.frontend_compose = args.frontend_compose or (packaged_frontend if packaged_frontend.exists() else APP_ROOT / 'release-template/compose.frontend.yml')
    args.knowledge_compose = args.knowledge_compose or args.compose_dir / 'knowledge-processor/compose.fragment.yml'
    args.vector_config = args.vector_config or args.compose_dir / 'volumes/logs/vector.yml'
    try:
        temp_root = Path(tempfile.gettempdir()).resolve()
        if any((parent / '.git').exists() for parent in (temp_root, *temp_root.parents)):
            raise CheckFailure('test scratch root must be outside every Git checkout')
        with tempfile.TemporaryDirectory(prefix='livo-docker-log-policy-') as directory:
            scratch = Path(directory)
            result = {'compose': compose_render_checks(args, scratch)}
            if args.config_only:
                result['native_vector'] = 'not_run_config_only'
            else:
                result['native_vector'] = native_vector_checks(args, scratch)
            print(json.dumps({'passed': True, **result}, sort_keys=True))
            return 0
    except (CheckFailure, OSError, subprocess.TimeoutExpired) as error:
        print('Docker log policy check failed: ' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
