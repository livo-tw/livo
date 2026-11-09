import { QaError } from './domain.ts';

type Row = Record<string, unknown>;
interface DisplayStore { rows(table: string, query: Row): Promise<Row[]> }
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);

/** Names for actual QA notifications received by the authenticated internal member. */
export async function loadQaNotificationPeople(db: DisplayStore, recipientId: string, input: unknown): Promise<{ memberNames: Record<string, string> }> {
  if (!validId(recipientId)) throw new QaError('qa_forbidden', 403);
  if (!Array.isArray(input) || input.length > 50 || !input.every(validId)) throw new QaError('qa_invalid_request');
  const ids = [...new Set<string>(input)];
  if (!ids.length) return { memberNames: {} };
  const notifications = await db.rows('notifications', { select: 'id,recipient_id,sender_id,type',
    recipient_id: `eq.${recipientId}`, type: 'eq.qa_update', id: `in.(${ids.join(',')})`, limit: '50' });
  const senders = [...new Set(notifications.filter(row => ids.includes(String(row.id)) && row.recipient_id === recipientId
    && row.type === 'qa_update' && validId(row.sender_id)).map(row => String(row.sender_id)))];
  if (!senders.length) return { memberNames: {} };
  const internal = await db.rows('members', { select: 'id,name', id: `in.(${senders.join(',')})`, limit: '50' });
  const known = new Set(internal.filter(row => senders.includes(String(row.id))).map(row => String(row.id)));
  const missing = senders.filter(sender => !known.has(sender));
  const external = missing.length ? await db.rows('external_qa_accounts', { select: 'id,name',
    id: `in.(${missing.join(',')})`, limit: '50' }) : [];
  const labels = [...internal.filter(row => senders.includes(String(row.id))), ...external.filter(row => missing.includes(String(row.id)))];
  return { memberNames: Object.fromEntries(labels.filter(row => typeof row.name === 'string' && row.name.trim()
    && row.name !== row.id).map(row => [String(row.id), String(row.name)])) };
}
