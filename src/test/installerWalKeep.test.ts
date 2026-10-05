// @vitest-environment node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// Both installers cap the WAL a stuck replication slot may hold (max_slot_wal_keep_size)
// on every install and upgrade. The fake database below keeps the setting as a string;
// the real step was checked against supabase/postgres 15.8.
const sh = readFileSync(new URL('../../release-template/install.sh', import.meta.url), 'utf8');
const ps = readFileSync(new URL('../../release-template/installer/install.ps1', import.meta.url), 'utf8');
const shFn = sh.match(/set_wal_keep_limit\(\) \{[\s\S]*?\n\}/)![0];
const psFn = ps.match(/function Set-WalKeepLimit \{[\s\S]*?\n\}/)![0];
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';

function runSh(envValue: string, setting: string, { reloadWorks = true } = {}) {
  const script = `say() { printf '%s\\n' "$*"; }
env_var() { printf '%s' "$ENV_VALUE"; }
# psql_c often runs inside $(...), so the call count goes to a file, not a variable.
log=$(mktemp); trap 'rm -f "$log"' EXIT
setting="$SETTING"; pending=""; writes=0
psql_c() {
  printf '%s\\n' "$1" >> "$log"
  case "$1" in
    "SELECT pg_size_bytes(current_setting('max_slot_wal_keep_size')) = pg_size_bytes('"*"')")
      want=\${1#*pg_size_bytes(\\'}; want=\${want%\\')}
      [ "$want" = "$setting" ] && printf t || printf f ;;
    "ALTER SYSTEM SET max_slot_wal_keep_size = '"*"'")
      writes=$((writes + 1)); pending=\${1#*= \\'}; pending=\${pending%\\'} ;;
    "SELECT pg_reload_conf()")
      [ "$RELOAD_WORKS" = 1 ] && setting="$pending"; printf t ;;
    *) printf 'unexpected SQL: %s\\n' "$1" >&2; exit 9 ;;
  esac
}
${shFn}
set_wal_keep_limit
printf 'setting=%s writes=%s calls=%s\\n' "$setting" "$writes" "$(wc -l < "$log" | tr -d ' ')"
`;
  return execFileSync(shell, ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, ENV_VALUE: envValue, SETTING: setting, RELOAD_WORKS: reloadWorks ? '1' : '0' },
  });
}

describe('WAL keep limit in the installers', () => {
  it('sets 512MB by default and changes nothing when it is already set', () => {
    const first = runSh('', '4GB');
    expect(first).toContain('[OK] 交易日誌保留上限已設為 512MB');
    expect(first).toContain('setting=512MB writes=1');
    const again = runSh('', '512MB');
    expect(again).toContain('[OK] 交易日誌保留上限：512MB');
    expect(again).toContain('writes=0 calls=1');
  });

  it('takes an override from docker/.env, including -1 for no limit', () => {
    expect(runSh('1GB', '512MB')).toContain('setting=1GB writes=1');
    expect(runSh('-1', '512MB')).toContain('setting=-1 writes=1');
  });

  it('refuses malformed values without touching the database', () => {
    for (const bad of ["1GB';DROP TABLE x;--", '512mb', '1.5GB', '512', 'MB']) {
      const out = runSh(bad, '4GB');
      expect(out).toContain('格式不對');
      expect(out).toContain('setting=4GB writes=0 calls=0');
    }
  });

  it('warns but goes on when the new value does not take effect', () => {
    const out = runSh('', '4GB', { reloadWorks: false });
    expect(out).toContain('無法設定交易日誌保留上限');
    expect(out).toContain('setting=4GB writes=1');
  });

  it('runs in the same place with the same rules in install.sh and install.ps1', () => {
    const order = (text: string, marks: string[]) => marks.map(mark => text.indexOf(mark));
    // The reset-code comment stays in the open-source export, which drops the call itself.
    const shAt = order(sh, ['# ---- first-run.sql', '\nset_wal_keep_limit\n', '# ---- 授權重置碼（每套安裝唯一']);
    const psAt = order(ps, ['Test-Path $FirstRun', '\nSet-WalKeepLimit\n', '# ---- 授權重置碼（每套安裝唯一']);
    for (const at of [shAt, psAt]) {
      expect(at.every(index => index >= 0)).toBe(true);
      expect(at[0]).toBeLessThan(at[1]);
      expect(at[1]).toBeLessThan(at[2]);
    }
    const pattern = '^(-1|[0-9]+(kB|MB|GB|TB))$';
    for (const fn of [shFn, psFn]) {
      expect(fn).toContain(pattern);
      expect(fn).toContain('LIVO_MAX_SLOT_WAL_KEEP_SIZE');
      expect(fn).toContain('pg_reload_conf()');
    }
    expect(shFn).toContain('_want=512MB');
    expect(psFn).toContain("$want = '512MB'");
    expect(psFn).toContain('-cnotmatch');
  });

  it.skipIf(process.platform !== 'win32')('behaves the same in the PowerShell installer', () => {
    const script = `$ErrorActionPreference='Stop'
function Ok($m) { Write-Output ('OK ' + $m) }
function Warn($m) { Write-Output ('WARN ' + $m) }
function Get-DotenvValue { return $script:envValue }
function Invoke-PsqlQuery([string]$Sql) {
  $script:calls++
  if ($Sql -match "^SELECT pg_size_bytes\\(current_setting\\('max_slot_wal_keep_size'\\)\\) = pg_size_bytes\\('(.*)'\\)$") { if ($Matches[1] -eq $script:setting) { return 't' } else { return 'f' } }
  if ($Sql -match "^ALTER SYSTEM SET max_slot_wal_keep_size = '(.*)'$") { $script:writes++; $script:pending = $Matches[1]; return '' }
  if ($Sql -eq 'SELECT pg_reload_conf()') { $script:setting = $script:pending; return 't' }
  throw ('unexpected SQL: ' + $Sql)
}
${psFn}
$script:envValue=''; $script:setting='4GB'; $script:writes=0; $script:calls=0
Set-WalKeepLimit; Set-WalKeepLimit
if ($script:setting -ne '512MB' -or $script:writes -ne 1) { exit 1 }
$script:envValue="1GB';DROP TABLE x;--"; $script:calls=0
Set-WalKeepLimit
if ($script:calls -ne 0 -or $script:setting -ne '512MB') { exit 1 }
$script:envValue='512mb'; Set-WalKeepLimit
if ($script:calls -ne 0) { exit 1 }
Write-Output 'pass'`;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })).toContain('pass');
  });
});
