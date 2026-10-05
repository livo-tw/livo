import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { functionErrorCode } from '@/lib/functionError';
import { activityActionLabelKey } from '@/lib/activityActions';
import { createMockClient } from '@/integrations/supabase/mockClient';
import zhTW from '@/i18n/locales/zh-TW.json';
import zhCN from '@/i18n/locales/zh-CN.json';
import en from '@/i18n/locales/en.json';

const lookup = (locale: unknown, key: string) => key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], locale);

describe('the code of a failed server function', () => {
  it('is read from the cloud error, the response body or the Docker response', async () => {
    expect(await functionErrorCode(null, { error: 'member_has_history' })).toBe('member_has_history');
    expect(await functionErrorCode({ message: 'This member has tasks', code: 'member_has_history' })).toBe('member_has_history');
    const docker = { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify({ error: 'member_has_history' }), { status: 409 }) };
    expect(await functionErrorCode(docker)).toBe('member_has_history');
    // Reading it twice works: the response is cloned.
    expect(await functionErrorCode(docker)).toBe('member_has_history');
    expect(await functionErrorCode({ context: new Response(JSON.stringify({ error: { code: 'nested' } })) })).toBe('nested');
    expect(await functionErrorCode({ message: 'offline' })).toBe('');
    expect(await functionErrorCode({ context: new Response('not json') })).toBe('');
  });
});

describe('deleting a member in the demo', () => {
  it('refuses a member with history like the servers, and removes one without', async () => {
    const client = createMockClient();
    const { data: tasks } = await client.from('tasks').select('assignee_id').not('assignee_id', 'is', null).limit(1);
    const busy = (tasks as Array<{ assignee_id: string }>)[0].assignee_id;
    const refused = await client.functions.invoke('manage-member', { body: { action: 'delete', memberId: busy } });
    expect(refused.data).toEqual({ error: 'member_has_history' });
    expect((await client.from('members').select('id').eq('id', busy)).data).toHaveLength(1);

    const created = await client.functions.invoke('manage-member', { body: { action: 'create', name: 'Added by mistake', email: 'mistake@example.com' } });
    const id = (created.data as { member: { id: string } }).member.id;
    expect((await client.functions.invoke('manage-member', { body: { action: 'delete', memberId: id } })).data).toEqual({ success: true });
  });
});

describe('the activity log names every action', () => {
  const files = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
  const written = new Set<string>();
  for (const file of files(join(process.cwd(), 'src'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\b(?:logActivity|log)\(\s*[\w.?]+(?:\([^)]*\))?\s*,\s*'([a-z_]+)'/g)) written.add(match[1]);
  }

  it('in every language, for each action the app writes', () => {
    expect(written.size).toBeGreaterThan(40);
    for (const action of [...written, 'task_work', 'approval_requested', 'approval_approved', 'create']) {
      const key = activityActionLabelKey(action);
      expect(key, action).not.toBe('activityLog.otherAction');
      for (const locale of [zhTW, zhCN, en]) expect(typeof lookup(locale, key), `${action} → ${key}`).toBe('string');
    }
  });

  it('shows an action from a newer server as "other", not its code', () => {
    expect(activityActionLabelKey('something_new')).toBe('activityLog.otherAction');
    for (const locale of [zhTW, zhCN, en]) expect(typeof lookup(locale, 'activityLog.otherAction')).toBe('string');
  });
});
