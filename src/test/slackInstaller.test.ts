// @vitest-environment node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('Slack internal secret installation', () => {
  it('generates once and preserves both a generated and a preexisting secret in POSIX installers', () => {
    const source = readFileSync(new URL('../../release-template/install.sh', import.meta.url), 'utf8');
    const fn = source.match(/ensure_slack_secret\(\) \{[\s\S]*?\n\}/)![0];
    const script = `env_var() { printf '%s' "$saved"; }
set_env_var() { saved="$2"; writes=$((writes + 1)); }
docker() { printf '%064d' 1; }
die() { exit 1; }
${fn}
saved=''; writes=0
ensure_slack_secret; first="$saved"; ensure_slack_secret
[ "$writes" = 1 ] && [ "$first" = "$saved" ] || exit 1
saved=existing-example-secret; ensure_slack_secret
[ "$writes" = 1 ] && [ "$saved" = existing-example-secret ] || exit 1
printf 'pass'
`;
    const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';
    expect(execFileSync(shell, ['-c', script], { encoding: 'utf8' }).trim()).toBe('pass');
  });
  it.skipIf(process.platform !== 'win32')('preserves secrets in the PowerShell installer', () => {
    const source = readFileSync(new URL('../../release-template/installer/install.ps1', import.meta.url), 'utf8');
    const fn = source.match(/function Ensure-SlackSecret \{[\s\S]*?\n\}/)![0];
    const script = `$ErrorActionPreference='Stop'
function Get-DotenvValue { return $script:saved }
function Set-DotenvVar { param($key,$value) $script:saved=$value; $script:writes++ }
${fn}
$script:saved=''; $script:writes=0
Ensure-SlackSecret; $first=$script:saved; Ensure-SlackSecret
if ($script:writes -ne 1 -or $first -ne $script:saved -or $first.Length -ne 64) { exit 1 }
$script:saved='existing-example-secret'; Ensure-SlackSecret
if ($script:writes -ne 1 -or $script:saved -ne 'existing-example-secret') { exit 1 }
Write-Output 'pass'`;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim()).toBe('pass');
  });
});
