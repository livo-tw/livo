// @vitest-environment node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

// With the knowledge processor on, the installers add its compose profile. They must
// keep the profiles docker/.env already lists (slack-delivery starts the Slack poller),
// or `docker compose up -d` leaves those services stopped.
const sh = readFileSync(new URL('../../release-template/install.sh', import.meta.url), 'utf8');
const ps = readFileSync(new URL('../../release-template/installer/install.ps1', import.meta.url), 'utf8');
const shFn = sh.match(/with_profile\(\) \{[\s\S]*?\n\}/)![0];
const psFn = ps.match(/function Get-ComposeProfilesWith\(\[string\]\$Name\) \{[\s\S]*?\n\}/)![0];
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'sh';

function merged(dotenv: string, shellProfiles?: string) {
  const script = `env_var() { [ "$1" = COMPOSE_PROFILES ] && printf '%s' "$DOTENV_PROFILES"; }
${shellProfiles === undefined ? 'unset COMPOSE_PROFILES' : 'COMPOSE_PROFILES="$SHELL_PROFILES"'}
${shFn}
with_profile knowledge-processor`;
  const env: NodeJS.ProcessEnv = { ...process.env, DOTENV_PROFILES: dotenv, SHELL_PROFILES: shellProfiles ?? '' };
  delete env.COMPOSE_PROFILES;
  return execFileSync(shell, ['-c', script], { encoding: 'utf8', env });
}

describe('compose profiles in the installers', () => {
  it('adds knowledge-processor and keeps what docker/.env lists', () => {
    expect(merged('')).toBe('knowledge-processor');
    expect(merged('slack-delivery')).toBe('slack-delivery,knowledge-processor');
    expect(merged('"slack-delivery"')).toBe('slack-delivery,knowledge-processor');
    expect(merged('slack-delivery,knowledge-processor')).toBe('slack-delivery,knowledge-processor');
  });

  it('starts from the shell value when one is set, as docker compose does', () => {
    expect(merged('slack-delivery', 'custom')).toBe('custom,knowledge-processor');
  });

  it('never replaces the profiles for the main `docker compose up`', () => {
    // A bare knowledge-processor value is only used inside a subshell (build, remove).
    const shBare = [...sh.matchAll(/^(.*)COMPOSE_PROFILES=knowledge-processor\b.*$/gm)].map(m => m[0]);
    expect(shBare.length).toBeGreaterThan(0);
    for (const line of shBare) expect(line).toMatch(/\(export COMPOSE_PROFILES=knowledge-processor;/);
    expect(sh).toContain('COMPOSE_PROFILES=$(with_profile knowledge-processor)');
    // PowerShell: only Remove-KnowledgeProcessor sets the bare value, and it restores the old one.
    const psBare = ps.split('\n').filter(line => line.includes("$env:COMPOSE_PROFILES = 'knowledge-processor'"));
    expect(psBare).toHaveLength(1);
    expect(ps).toMatch(/\$env:COMPOSE_PROFILES = 'knowledge-processor'\r?\n\s*try \{ Invoke-Compose rm -s -f knowledge-processor \*> \$null \} finally \{ \$env:COMPOSE_PROFILES = \$previousProfiles \}/);
    expect(ps).toContain("$env:COMPOSE_PROFILES = Get-ComposeProfilesWith 'knowledge-processor'");
  });

  it.skipIf(process.platform !== 'win32')('merges the same way in the PowerShell installer', () => {
    const script = `$ErrorActionPreference='Stop'
function Get-DotenvValue { return $script:dotenv }
${psFn}
$env:COMPOSE_PROFILES=$null
$script:dotenv=$null; $a = Get-ComposeProfilesWith 'knowledge-processor'
$script:dotenv='slack-delivery'; $b = Get-ComposeProfilesWith 'knowledge-processor'
$script:dotenv='"slack-delivery,knowledge-processor"'; $c = Get-ComposeProfilesWith 'knowledge-processor'
Write-Output "$a|$b|$c"`;
    expect(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' }).trim())
      .toBe('knowledge-processor|slack-delivery,knowledge-processor|slack-delivery,knowledge-processor');
  });
});
