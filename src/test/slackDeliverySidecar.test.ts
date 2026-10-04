// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(new URL('../../release-template/compose.frontend.yml', import.meta.url), 'utf8');
/** The shell script Compose hands to the delivery sidecar, after Compose's `$$` unescaping. */
function deliveryScript(): string {
  const service = compose.split(/\n  livo-slack-delivery:\n/)[1].split(/\n  [a-z][\w-]*:\n/)[0];
  const block = service.split(/\n      - \|\n/)[1];
  return block.split('\n').filter(line => line.startsWith('        ') || !line.trim())
    .map(line => line.slice(8)).join('\n').replace(/\$\$/g, '$');
}
const commandLines = () => readdirSync('/proc').filter(name => /^\d+$/.test(name)).map(pid => {
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { return ''; }
});

describe('Slack delivery sidecar', () => {
  it('never places the internal secret or API key on a command line', () => {
    const script = deliveryScript();
    expect(script).toContain('slack-deliver');
    for (const line of script.split('\n').filter(l => /\bcurl\b/.test(l) || /^\s*-H\b/.test(l)))
      expect(line).not.toMatch(/SLACK_INTERNAL_SECRET|ANON_KEY/);
  });

  it.skipIf(process.platform !== 'linux')('sends both headers from stdin while ps cannot see them', async () => {
    const secret = `example-internal-secret-${'7'.repeat(40)}`, anon = `example-anon-key-${'5'.repeat(40)}`;
    let seen: IncomingHttpHeaders | undefined, leaked: string[] = [];
    const server = createServer((req, res) => {
      seen = req.headers;
      // Inspect every process while curl is still connected.
      leaked = commandLines().filter(line => line.includes(secret) || line.includes(anon));
      res.end('{}');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/functions/v1/slack-deliver`;
    const once = deliveryScript().replace('http://kong:8000/functions/v1/slack-deliver', url).replace(/sleep 5/, 'exit 0');
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn('sh', ['-c', once], { env: { PATH: process.env.PATH || '/usr/bin:/bin', SLACK_INTERNAL_SECRET: secret, ANON_KEY: anon } });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`exit ${code}`)));
      });
    } finally { server.close(); }
    expect(seen?.['x-livo-slack-secret']).toBe(secret);
    expect(seen?.authorization).toBe(`Bearer ${anon}`);
    expect(leaked).toEqual([]);
  });
});
