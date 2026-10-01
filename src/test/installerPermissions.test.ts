// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(__dirname, '../..');
const helper = readFileSync(path.join(root, 'release-template/installer/permissions.sh'), 'utf8');
// NTFS does not represent these modes. Use WSL's temporary filesystem on Windows,
// or skip the shell cases if WSL is unavailable; Linux/macOS run them directly.
const shell = process.platform === 'win32' ? 'wsl.exe' : 'sh';
const shellArgs = process.platform === 'win32' ? ['--exec', 'sh', '-s'] : ['-s'];
const canRunShell = process.platform !== 'win32' || spawnSync(shell, shellArgs, {
  input: 'test -x /bin/sh\n', encoding: 'utf8', timeout: 15_000,
}).status === 0;

function run(commands: string) {
  const result = spawnSync(shell, shellArgs, {
    input: `set -eu
umask 077
test_dir=$(mktemp -d /tmp/livo-permissions.XXXXXX)
case "$test_dir" in /tmp/livo-permissions.*) ;; *) exit 1 ;; esac
trap 'rm -rf "$test_dir"' EXIT HUP INT TERM
ROOT="$test_dir/install with spaces"
mkdir -p "$ROOT/docker/volumes/api" "$ROOT/app/nested" \\
  "$ROOT/docker/volumes/db/data" "$ROOT/docker/volumes/storage" "$ROOT/backups"
printf 'config' > "$ROOT/docker/volumes/api/kong.yml"
printf '#!/bin/sh\\n' > "$ROOT/docker/volumes/api/kong-entrypoint.sh"
printf 'app' > "$ROOT/app/nested/main.js"
printf 'fake-secret' > "$ROOT/docker/.env"
printf 'factory' > "$ROOT/docker/.env.factory"
printf 'database' > "$ROOT/docker/volumes/db/data/x.sh"
printf 'upload' > "$ROOT/docker/volumes/storage/y.sh"
printf 'backup' > "$ROOT/backups/saved.sh"
cat > "$test_dir/permissions.sh" <<'LIVO_TEST_PERMISSIONS_EOF'
${helper}
LIVO_TEST_PERMISSIONS_EOF
. "$test_dir/permissions.sh"
assert_mode() {
  test -n "$(find "$1" -prune -perm "$2" -print)" || {
    printf 'Unexpected mode: %s (expected %s)\\n' "$1" "$2" >&2
    exit 1
  }
}
${commands}
`,
    encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status, result.stdout).toBe(0);
  return result.stdout;
}

describe('installer permission integration', () => {
  it('runs after bundle rewrites, before the first compose up, and packages the helper', () => {
    const installer = readFileSync(path.join(root, 'release-template/install.sh'), 'utf8');
    const call = installer.indexOf('normalize_package_permissions "$ROOT"');
    expect(call).toBeGreaterThan(installer.indexOf('\nsync_frontend_anon_key\n'));
    expect(call).toBeLessThan(installer.indexOf('if ! dc up -d'));
    expect(installer).toContain('. "$ROOT/installer/permissions.sh"');
    expect(readFileSync(path.join(root, 'scripts/build-release.mjs'), 'utf8'))
      .toContain("path.join(INSTALLER_DEST, 'permissions.sh')");
  });

  it('filters by current ownership, without escalating or changing ownership', () => {
    // Real chown is unavailable in ordinary developer/CI accounts.
    expect(helper).toContain('-user "$(id -u)"');
    expect(helper).not.toMatch(/\b(?:sudo|chown)\b/);
  });
});

describe.skipIf(!canRunShell)('installer permissions on a POSIX filesystem', () => {
  it('repairs restrictive files and directories without entering data or changing secrets', () => {
    const out = run(`
normalize_package_permissions "$ROOT"
assert_mode "$ROOT/docker/volumes/api/kong.yml" 0644
assert_mode "$ROOT/docker/volumes/api/kong-entrypoint.sh" 0755
assert_mode "$ROOT/app/nested/main.js" 0644
assert_mode "$ROOT/app/nested" 0755
assert_mode "$ROOT/docker/.env" 0600
assert_mode "$ROOT/docker/.env.factory" 0600
for dir in docker/volumes/db/data docker/volumes/storage backups; do
  assert_mode "$ROOT/$dir" 0700
done
for file in docker/volumes/db/data/x.sh docker/volumes/storage/y.sh backups/saved.sh; do
  assert_mode "$ROOT/$file" 0600
done
test "$(cat "$ROOT/docker/.env")" = fake-secret
test "$(cat "$ROOT/docker/volumes/db/data/x.sh")" = database
test "$(cat "$ROOT/docker/volumes/storage/y.sh")" = upload
`);
    expect(out).toMatch(/^  \[OK\] 程式檔權限已確認（3 個檔案）\n$/);
  });

  it('is additive and repeatable, preserving existing write and execute bits', () => {
    const out = run(`
chmod 0660 "$ROOT/docker/volumes/api/kong.yml"
chmod 0770 "$ROOT/docker/volumes/api/kong-entrypoint.sh" "$ROOT/app/nested"
chmod 0701 "$ROOT/app/nested/main.js"
normalize_package_permissions "$ROOT"
normalize_package_permissions "$ROOT"
assert_mode "$ROOT/docker/volumes/api/kong.yml" 0664
assert_mode "$ROOT/docker/volumes/api/kong-entrypoint.sh" 0775
assert_mode "$ROOT/app/nested" 0775
assert_mode "$ROOT/app/nested/main.js" 0745
`);
    expect(out.match(/\[OK\]/g)).toHaveLength(2);
    expect(out).not.toContain('[!]');
  });

  it('restricts a loose .env to 600 and reports the change without printing its contents', () => {
    const out = run(`
chmod 0644 "$ROOT/docker/.env"
normalize_package_permissions "$ROOT"
assert_mode "$ROOT/docker/.env" 0600
test "$(cat "$ROOT/docker/.env")" = fake-secret
`);
    expect(out).toContain('docker/.env 權限設為 600');
    expect(out).not.toContain('fake-secret');
  });

  it('does not follow symlinks to runtime data or an external tree', () => {
    run(`
mkdir "$test_dir/outside"
printf 'outside' > "$test_dir/outside/private.sh"
ln -s "$test_dir/outside" "$ROOT/app/linked-directory"
ln -s "$ROOT/docker/volumes/storage/y.sh" "$ROOT/app/linked-file.sh"
normalize_package_permissions "$ROOT"
assert_mode "$test_dir/outside" 0700
assert_mode "$test_dir/outside/private.sh" 0600
assert_mode "$ROOT/docker/volumes/storage/y.sh" 0600
`);
  });

  it('warns with repair commands and continues when chmod fails', () => {
    const out = run(`
mkdir "$test_dir/bin"
printf '#!/bin/sh\\nexit 1\\n' > "$test_dir/bin/chmod"
chmod 0755 "$test_dir/bin/chmod"
chmod 0644 "$ROOT/docker/.env"
PATH="$test_dir/bin:$PATH"
export PATH
normalize_package_permissions "$ROOT"
assert_mode "$ROOT/docker/volumes/api/kong.yml" 0600
assert_mode "$ROOT/docker/.env" 0644
printf 'continued\\n'
`);
    expect(out).toContain('chmod 600 docker/.env');
    expect(out).toContain('chmod a+r "./docker/volumes/api/kong.yml"');
    expect(out).toContain('chmod a+rx "./docker/volumes/api/kong-entrypoint.sh"');
    expect(out).toContain('[OK] 程式檔權限已確認（0 個檔案）');
    expect(out).toContain('continued');
  });
});
