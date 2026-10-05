// Service integrations (Slack, email, webhooks, API keys) are managed by super_admins only,
// the same rule as the Integrations page. An admin's request is refused before any handler runs.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const index = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const route = (method: 'get' | 'post', name: string) => index.split('\n').find(line => line.includes(`app.${method}('/api/functions/${name}'`)) || '';

describe('integration endpoints', () => {
  it.each([['post', 'slack-config'], ['post', 'email-config'], ['get', 'webhooks'], ['post', 'webhooks'], ['get', 'api-tokens'], ['post', 'api-tokens']] as const)(
    '%s %s requires a super_admin', (method, name) => {
      const line = route(method, name);
      expect(line).toContain('requireSuperAdmin');
      expect(line).not.toMatch(/requireAdmin\b/);
    });
  it('keeps the masked status readable by every member', () => {
    expect(route('get', 'slack-config')).not.toMatch(/requireAdmin|requireSuperAdmin/);
    expect(route('get', 'email-config')).not.toMatch(/requireAdmin|requireSuperAdmin/);
  });
});

describe('Docker integration functions', () => {
  const root = path.resolve(__dirname, '../..');
  // The open-source export has only docker/volumes/functions; the private repo also has supabase/functions.
  it.each(['slack-config', 'email-config', 'webhooks'])('%s accepts only super_admin in every copy', name => {
    const copies = ['supabase/functions', 'docker/volumes/functions'].map(base => path.join(root, base, name, 'index.ts')).filter(file => fs.existsSync(file));
    expect(copies.length).toBeGreaterThan(0);
    for (const file of copies) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toContain("['admin', 'super_admin'].includes(member.role");
      // Check what the handler actually rejects, rather than looking for a role
      // substring: `!member.role === 'super_admin'` contains one and rejects nobody.
      const conditions = [...source.matchAll(/if\s*\(([^()]*member\.role[^()]*)\)\s*\{/g)];
      expect(conditions).toHaveLength(1);
      const rejects = new Function('member', `return ${conditions[0][1]};`) as (member: { role: string } | null) => boolean;
      for (const member of [null, { role: 'member' }, { role: 'admin' }, { role: '' }]) expect(rejects(member)).toBe(true);
      expect(rejects({ role: 'super_admin' })).toBe(false);
    }
  });
});
