// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadQaNotificationPeople } from '../../docker/volumes/functions/qa/notificationPeople';
import { qaNotificationPeople } from '../lib/qa/notificationPeople';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: transport } } }));
type Row = Record<string, unknown>;
const recipient = 'member-example';
const own = (id: string, sender: string): Row => ({ id, sender_id: sender, recipient_id: recipient, type: 'qa_update' });
function store(notifications: Row[], internal: Row[] = [], external: Row[] = []) {
  const calls: Array<{ table: string; query: Row }> = [];
  return { calls, async rows(table: string, query: Row): Promise<Row[]> {
    calls.push({ table, query });
    if (table === 'notifications') return notifications;
    if (table === 'members') return internal;
    if (table === 'external_qa_accounts') return external;
    throw new Error('Unexpected table');
  } };
}
beforeEach(() => transport.mockReset());

describe('QA notification sender labels', () => {
  it('derives labels only from actual QA notifications received by the caller, with internal precedence', async () => {
    const db = store([own('n-one', 'visitor-example'), own('n-two', 'eqa-internal-example'),
      { ...own('n-other', 'not-allowed'), recipient_id: 'someone-else' },
      { ...own('n-system', 'not-system'), type: 'system' }, own('n-unrequested', 'unrequested')],
    [{ id: 'eqa-internal-example', name: 'Example internal' }],
    [{ id: 'visitor-example', name: 'Example collaborator' }, { id: 'eqa-internal-example', name: 'Wrong label' },
      { id: 'not-allowed', name: 'Private account' }]);
    expect(await loadQaNotificationPeople(db, recipient, ['n-one', 'n-two', 'n-other', 'n-system']))
      .toEqual({ memberNames: { 'eqa-internal-example': 'Example internal', 'visitor-example': 'Example collaborator' } });
    expect(db.calls[0].query).toMatchObject({ recipient_id: 'eq.member-example', type: 'eq.qa_update', limit: '50' });
    expect(db.calls.find(call => call.table === 'external_qa_accounts')?.query)
      .toEqual({ select: 'id,name', id: 'in.(visitor-example)', limit: '50' });
  });
  it('does not look up accounts for missing notifications or an empty request', async () => {
    const db = store([]);
    expect(await loadQaNotificationPeople(db, recipient, [])).toEqual({ memberNames: {} });
    expect(db.calls).toHaveLength(0);
    expect(await loadQaNotificationPeople(db, recipient, ['n-one'])).toEqual({ memberNames: {} });
    expect(db.calls).toHaveLength(1);
  });
  it('rejects injected IDs and unbounded requests before any read', async () => {
    const db = store([]);
    for (const ids of [['n-one),other'], Array.from({ length: 51 }, (_, index) => `n-${index}`), 'n-one'])
      await expect(loadQaNotificationPeople(db, recipient, ids)).rejects.toMatchObject({ code: 'qa_invalid_request' });
    expect(db.calls).toHaveLength(0);
  });
  it('does not invent a raw-ID label for an unknown sender', async () => {
    const db = store([own('n-one', 'visitor-example')], [], [{ id: 'visitor-example', name: 'visitor-example' }]);
    expect(await loadQaNotificationPeople(db, recipient, ['n-one'])).toEqual({ memberNames: {} });
  });
  it('sends only notification IDs and discards unrelated or invalid response labels', async () => {
    transport.mockResolvedValue({ data: { memberNames: { 'visitor-example': 'Example collaborator', other: 'Private', bad: 4 } }, error: null });
    const signal = new AbortController().signal;
    expect(await qaNotificationPeople([{ id: 'n-one', senderId: 'visitor-example', type: 'qa_update' },
      { id: 'n-two', senderId: 'other', type: 'comment' }], signal)).toEqual({ 'visitor-example': 'Example collaborator' });
    expect(transport).toHaveBeenCalledWith('qa', { body: { action: 'notification_people', notificationIds: ['n-one'] }, signal });
  });
  it('discards aborted labels and exposes read failures to the caller', async () => {
    const controller = new AbortController(); controller.abort();
    transport.mockResolvedValue({ data: { memberNames: { visitor: 'Example' } }, error: null });
    expect(await qaNotificationPeople([{ id: 'n-one', senderId: 'visitor', type: 'qa_update' }], controller.signal)).toEqual({});
    transport.mockResolvedValue({ data: null, error: new Error('Unavailable') });
    await expect(qaNotificationPeople([{ id: 'n-one', senderId: 'visitor', type: 'qa_update' }])).rejects.toThrow('Unavailable');
  });
});
