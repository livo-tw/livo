// @vitest-environment node
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { startRelay } from '../../release-template/slack-socket.mjs';

const until = async (condition: () => boolean) => {
  const end = Date.now() + 7000;
  while (!condition()) { if (Date.now() > end) throw new Error('Test timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};
function frame(body: unknown) {
  const data = Buffer.from(JSON.stringify(body)), header = Buffer.alloc(data.length < 126 ? 2 : 4);
  header[0] = 0x81; header[1] = data.length < 126 ? data.length : 126;
  if (data.length >= 126) header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}
describe('built-in Socket Mode relay', () => {
  it('exits quietly without a token or any network activity', () => {
    const network = vi.fn(), log = vi.fn();
    const relay = startRelay({ fetchImpl: network, log });
    expect(relay.active).toBe(false); expect(network).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled(); relay.stop();
  });
  it('ACKs within 3 seconds, forwards the secret, returns options, deduplicates and reconnects', async () => {
    const sockets: Duplex[] = [], acks: { data: any; at: number }[] = [], forwarded: any[] = [], logs: string[] = [];
    let base = '', seenSecret = '', opens = 0;
    const server = createServer(async (req, res) => {
      if (req.url === '/open') { opens++; res.end(JSON.stringify({ ok: true, url: base.replace('http:', 'ws:') + '/socket' })); return; }
      let raw = ''; for await (const part of req) raw += part;
      const envelope = JSON.parse(raw); seenSecret = String(req.headers['x-livo-slack-secret']);
      if (envelope.payload.type !== 'heartbeat') forwarded.push(envelope);
      if (envelope.envelope_id === 'slow') await new Promise(resolve => setTimeout(resolve, 2800));
      res.end(JSON.stringify(envelope.envelope_id === 'disabled' ? { disabled: true } : { options: [] }));
    });
    server.on('upgrade', (req, socket) => {
      const accept = createHash('sha1').update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      sockets.push(socket); let buffer = Buffer.alloc(0);
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 6) {
          const opcode = buffer[0] & 15; let length = buffer[1] & 127, start = 2;
          if (length === 126) { if (buffer.length < 8) return; length = buffer.readUInt16BE(2); start = 4; }
          if (buffer.length < start + 4 + length) return;
          const mask = buffer.subarray(start, start + 4), data = Buffer.from(buffer.subarray(start + 4, start + 4 + length));
          for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
          buffer = buffer.subarray(start + 4 + length);
          if (opcode === 1) acks.push({ data: JSON.parse(data.toString()), at: Date.now() });
          if (opcode === 8) socket.destroy();
        }
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const secret = 'example-secret-'.repeat(4);
    const relay = startRelay({ token: 'example-app-token', secret, upstream: base + '/upstream', connectionsUrl: base + '/open',
      reconnectMs: 25, heartbeatMs: 60000, log: text => logs.push(text) });
    try {
      await until(() => sockets.length === 1);
      const send = (id: string) => sockets[sockets.length - 1].write(frame({ envelope_id: id, type: 'interactive',
        accepts_response_payload: true, payload: { type: 'block_suggestion', value: 'private-example-content' } }));
      send('options'); await until(() => acks.length === 1);
      expect(acks[0].data).toEqual({ envelope_id: 'options', payload: { options: [] } });
      expect(seenSecret).toBe(secret); expect(forwarded[0].payload.value).toBe('private-example-content');
      const start = Date.now(); send('slow'); await until(() => acks.some(a => a.data.envelope_id === 'slow'));
      expect(acks.find(a => a.data.envelope_id === 'slow')!.at - start).toBeLessThan(3000);
      sockets[0].destroy(); await until(() => sockets.length === 2);
      send('disabled'); await until(() => acks.some(a => a.data.envelope_id === 'disabled'));
      send('disabled'); await until(() => acks.filter(a => a.data.envelope_id === 'disabled').length === 2);
      expect(forwarded.filter(e => e.envelope_id === 'disabled')).toHaveLength(1);
      expect(opens).toBe(2);
      expect(logs.join('\n')).not.toMatch(/private-example-content|example-app-token|example-secret/);
    } finally {
      relay.stop(); for (const socket of sockets) socket.destroy();
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15000);
});
