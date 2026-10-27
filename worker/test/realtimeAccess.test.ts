// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeHub } from '../src/realtime';
import { realtimeIdentity, realtimeIdentityActive, type RealtimeIdentity } from '../src/realtimeAccess';
import type { ChangeEvent } from '../src/protocol';
import { backendAccessFixture } from './backendAccessFixture';

type TestSocketState = RealtimeIdentity & { lastSeen: number; channels: Map<string, { bindings: Array<{ table: string; event: string }> }> };
type HubRuntime = {
  sockets: Map<WebSocket, TestSocketState>;
  onMessage(socket: WebSocket, event: MessageEvent): Promise<void>;
  broadcastPresence(channel: string): Promise<void>;
  queuePresenceBroadcast(channel: string): void;
  presenceFlush: Promise<void> | null;
  presence: Map<string, Map<WebSocket, { key: string; payload: Record<string, unknown> }>>;
  sweep(): void;
};
describe('live realtime authorization and private notification delivery', () => {
  let fixture: ReturnType<typeof backendAccessFixture>;
  beforeEach(() => { fixture = backendAccessFixture(); });
  afterEach(() => { fixture.db.close(); vi.useRealTimers(); });
  const identity = (id = 'member'): RealtimeIdentity => ({
    userId: `login-${id}`, memberId: id, workspaceId: 'access-a', email: `${id}@example.com`, expiresAt: Math.floor(Date.now() / 1000) + 3600,
  });
  function connection(id = 'member') {
    const sent: Array<Record<string, unknown>> = [], close = vi.fn();
    const socket = { send: (text: string) => sent.push(JSON.parse(text)), close } as unknown as WebSocket;
    const hub = new RealtimeHub({} as DurableObjectState, fixture.env);
    const runtime = hub as unknown as HubRuntime;
    runtime.sockets.set(socket, { ...identity(id), lastSeen: Date.now(), channels: new Map([
      ['example', { bindings: ['tasks', 'notifications', 'kb_pages'].map(table => ({ table, event: '*' })) }],
    ]) });
    return { hub, runtime, socket, sent, close };
  }
  const deliver = (hub: RealtimeHub, events: ChangeEvent[], workspaceId = 'access-a') => hub.fetch(new Request('https://do/notify', {
    method: 'POST', headers: { 'x-workspace-id': workspaceId }, body: JSON.stringify(events),
  }));
  const taskEvent: ChangeEvent = { table: 'tasks', eventType: 'UPDATE', new: { id: 'example-task', workspace_id: 'access-a', title: 'Example current work' }, old: null };
  const notice = (recipient: string): ChangeEvent => ({ table: 'notifications', eventType: 'INSERT', new: { id: `example-${recipient}`, workspace_id: 'access-a', recipient_id: recipient, content: 'Example private notice' }, old: null });
  function deferredIdentityReads() {
    const reads: Array<{ released: boolean; release(): void }> = [];
    const prepare = fixture.env.DB.prepare.bind(fixture.env.DB);
    vi.spyOn(fixture.env.DB, 'prepare').mockImplementation(sql => {
      const statement = prepare(sql);
      return {
        ...statement,
        bind: (...args: unknown[]) => {
          const bound = statement.bind(...args);
          return {
            ...bound,
            first: () => new Promise(resolve => {
              const read = { released: false, release: () => { read.released = true; void Promise.resolve(bound.first()).then(resolve); } };
              reads.push(read);
            }),
          } as unknown as D1PreparedStatement;
        },
      } as unknown as D1PreparedStatement;
    });
    return reads;
  }
  const settleMicrotasks = async () => { for (let turn = 0; turn < 8; turn++) await Promise.resolve(); };

  it('requires complete trusted identity and a real expiry at the handshake', () => {
    const expected = identity();
    const headers = new Headers({ 'x-auth-user': 'login-member', 'x-auth-email': 'member@example.com' });
    expect(realtimeIdentity(headers)).toBeNull();
    headers.set('x-auth-member', 'member'); headers.set('x-auth-workspace', 'access-a'); headers.set('x-auth-exp', String(expected.expiresAt));
    expect(realtimeIdentity(headers)).toEqual(expected);
  });

  it('allows a current identity, heartbeat and normal task updates', async () => {
    const connectionState = connection();
    expect(await realtimeIdentityActive(fixture.env, identity())).toBe(true);
    await connectionState.runtime.onMessage(connectionState.socket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    await deliver(connectionState.hub, [taskEvent]);
    expect(connectionState.sent.map(message => message.t)).toEqual(['hb_ack', 'change']);
    expect(connectionState.close).not.toHaveBeenCalled();
  });

  it('preserves leave then join order when identity reads would otherwise finish in reverse', async () => {
    const current = connection();
    const reads = deferredIdentityReads();
    const leave = current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'leave', ch: 'example' }) } as MessageEvent);
    const join = current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'join', ch: 'example', bindings: [] }) } as MessageEvent);
    await settleMicrotasks();
    // An unsequenced implementation starts both reads; deliberately finish the second first.
    if (reads[1]) { reads[1].release(); await join; }
    reads[0].release(); await leave;
    await settleMicrotasks();
    if (reads[1] && !reads[1].released) reads[1].release();
    await join;
    expect(current.runtime.sockets.get(current.socket)!.channels.has('example')).toBe(true);
  });

  it('does not execute queued messages or start another identity read after revocation', async () => {
    const current = connection();
    const reads = deferredIdentityReads();
    const first = current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    const queued = current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'join', ch: 'new-channel', bindings: [] }) } as MessageEvent);
    await settleMicrotasks();
    fixture.db.exec("UPDATE members SET is_active=0 WHERE id='member'");
    reads[0].release(); await first;
    if (reads[1]) reads[1].release();
    await queued;
    expect(reads).toHaveLength(1);
    expect(current.sent).toHaveLength(0);
    expect(current.runtime.sockets.size).toBe(0);
  });

  it('lets another socket progress while one socket waits for its identity read', async () => {
    const current = connection();
    const otherSent: Array<Record<string, unknown>> = [];
    const otherSocket = { send: (text: string) => otherSent.push(JSON.parse(text)), close: vi.fn() } as unknown as WebSocket;
    current.runtime.sockets.set(otherSocket, { ...identity('other'), lastSeen: Date.now(), channels: new Map() });
    const reads = deferredIdentityReads();
    const first = current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    const other = current.runtime.onMessage(otherSocket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    await settleMicrotasks();
    expect(reads).toHaveLength(2);
    reads[1].release(); await other;
    expect(otherSent).toEqual([{ t: 'hb_ack' }]);
    expect(current.sent).toHaveLength(0);
    reads[0].release(); await first;
  });

  it('rechecks JWT expiry after a deferred live-identity database read', async () => {
    vi.useFakeTimers();
    const expires = identity();
    const reads = deferredIdentityReads();
    const active = realtimeIdentityActive(fixture.env, expires);
    vi.setSystemTime((expires.expiresAt + 1) * 1000);
    reads[0].release();
    expect(await active).toBe(false);
  });

  it.each(['member', 'admin', 'super'])('only delivers %s its own notification even with an unfiltered subscription', async id => {
    const current = connection(id);
    await deliver(current.hub, [notice(id), notice('other')]);
    expect(current.sent).toHaveLength(1);
    expect(current.sent[0].new).toEqual(expect.objectContaining({ recipient_id: id }));
  });

  it('redacts another recipient old row during a privileged re-address', async () => {
    const current = connection();
    const event = { ...notice('member'), eventType: 'UPDATE' as const, old: notice('other').new };
    await deliver(current.hub, [event]);
    expect(current.sent[0].old).toBeNull();
  });

  it.each([
    "UPDATE members SET is_active=0 WHERE id='member'",
    "UPDATE members SET auth_id=NULL WHERE id='member'",
    "UPDATE auth_users SET banned=1 WHERE id='login-member'",
    "UPDATE auth_users SET email='renamed@example.com' WHERE id='login-member'",
  ])('closes an existing connection after identity revocation: %s', async sql => {
    const current = connection();
    fixture.db.exec(sql);
    await current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    await deliver(current.hub, [taskEvent]);
    expect(current.sent).toHaveLength(0);
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('rechecks a silent socket before delivering data after deactivation', async () => {
    const current = connection();
    fixture.db.exec("UPDATE members SET is_active=0 WHERE id='member'");
    await deliver(current.hub, [taskEvent]);
    expect(current.sent).toHaveLength(0);
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('does not deliver presence to a revoked socket while other members remain active', async () => {
    const current = connection();
    fixture.db.exec("UPDATE members SET is_active=0 WHERE id='member'");
    await current.runtime.broadcastPresence('example');
    expect(current.sent).toHaveLength(0);
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('coalesces a group of revoked viewers without recursive presence fetches', async () => {
    const current = connection();
    const sockets = [current.socket];
    const presence = new Map<WebSocket, { key: string; payload: Record<string, unknown> }>();
    presence.set(current.socket, { key: 'example', payload: { memberId: 'member' } });
    for (let index = 0; index < 11; index++) {
      const socket = { send: vi.fn(), close: vi.fn() } as unknown as WebSocket;
      sockets.push(socket);
      current.runtime.sockets.set(socket, { ...identity(), lastSeen: Date.now(), channels: new Map([
        ['example', { bindings: [{ table: 'tasks', event: '*' }] }],
      ]) });
      presence.set(socket, { key: 'example', payload: { memberId: 'member' } });
    }
    current.runtime.presence.set('example', presence);
    fixture.db.exec("UPDATE members SET is_active=0 WHERE id='member'");
    const reads = vi.spyOn(fixture.env.DB, 'prepare');
    current.runtime.queuePresenceBroadcast('example');
    await current.runtime.presenceFlush;
    expect(current.runtime.sockets.size).toBe(0);
    expect(current.runtime.presence.size).toBe(0);
    expect(reads).toHaveBeenCalledTimes(sockets.length);
    expect(current.sent).toHaveLength(0);
  });

  it('never retains broader notification or knowledge payload access after a role change', async () => {
    const current = connection('super');
    fixture.db.exec("UPDATE members SET role='member' WHERE id='super'");
    await deliver(current.hub, [notice('other'), notice('super'), {
      table: 'kb_pages', eventType: 'UPDATE', new: { workspace_id: 'access-a', body: 'Restricted role-specific example' }, old: null,
    }]);
    expect(current.sent).toHaveLength(2);
    expect(current.sent[0].new).toEqual(expect.objectContaining({ recipient_id: 'super' }));
    expect(current.sent[1]).toEqual(expect.objectContaining({ new: {}, old: null }));
  });

  it('does not let heartbeats extend JWT expiry', async () => {
    const current = connection();
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 3_601_000);
    await current.runtime.onMessage(current.socket, { data: JSON.stringify({ t: 'hb' }) } as MessageEvent);
    await deliver(current.hub, [taskEvent]);
    expect(current.sent).toHaveLength(0);
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('expires a quiet connection even without client messages or table events', () => {
    const current = connection();
    current.runtime.sockets.get(current.socket)!.expiresAt = Math.floor(Date.now() / 1000);
    current.runtime.sweep();
    expect(current.close).toHaveBeenCalledTimes(1);
  });

  it('rejects foreign workspace routing and inconsistent row scope', async () => {
    const current = connection();
    await deliver(current.hub, [taskEvent], 'access-b');
    await deliver(current.hub, [{ ...taskEvent, new: { ...taskEvent.new, workspace_id: 'access-b' } }]);
    expect(current.sent).toHaveLength(0);
    expect(current.close).not.toHaveBeenCalled();
  });

  it('keeps knowledge events as body-free invalidations', async () => {
    const current = connection();
    await deliver(current.hub, [{ table: 'kb_pages', eventType: 'UPDATE', new: { workspace_id: 'access-a', title: 'Private example', body: 'Restricted text' }, old: { body: 'Old restricted text' } }]);
    expect(current.sent[0]).toEqual(expect.objectContaining({ new: {}, old: null }));
  });

  it('fails closed when live identity cannot be read', async () => {
    const current = connection();
    fixture.db.close();
    await deliver(current.hub, [taskEvent]);
    expect(current.sent).toHaveLength(0);
    expect(current.close).toHaveBeenCalledTimes(1);
    // afterEach still owns a live test database.
    fixture = backendAccessFixture();
  });
});
