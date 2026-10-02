// Transport only. Node 22 built-ins; never log URLs, tokens, envelopes or payloads.
import { pathToFileURL } from 'node:url';

export function startRelay({ token, secret, anonKey = '', upstream = 'http://kong:8000/functions/v1/slack-interact',
  connectionsUrl = 'https://slack.com/api/apps.connections.open', WebSocketImpl = globalThis.WebSocket,
  fetchImpl = globalThis.fetch, log = () => {}, reconnectMs = 1000, heartbeatMs = 30000, ackMs = 2200 } = {}) {
  if (!token) return { stop() {}, active: false };
  if (!secret || secret.length < 32) throw new Error('Slack internal secret is missing');
  let stopped = false, socket, reconnectTimer, attempts = 0, connecting = false;
  const pending = new Map();
  const headers = { 'Content-Type': 'application/json', 'x-livo-slack-secret': secret,
    ...(anonKey ? { Authorization: `Bearer ${anonKey}` } : {}) };
  async function forward(envelope) {
    const res = await fetchImpl(upstream, { method: 'POST', headers, body: JSON.stringify(envelope), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error('Upstream unavailable');
    return res.json();
  }
  const heartbeat = connected => forward({ envelope_id: 'heartbeat', payload: { type: 'heartbeat', connected } }).catch(() => {});
  function schedule() {
    if (stopped || reconnectTimer) return;
    const delay = Math.min(30000, reconnectMs * 2 ** Math.min(attempts++, 5));
    reconnectTimer = setTimeout(() => { reconnectTimer = undefined; void connect(); }, delay);
  }
  async function receive(ws, raw) {
    let envelope;
    try { envelope = JSON.parse(String(raw)); } catch { return; }
    if (envelope.type === 'disconnect') { ws.close(); return; }
    if (typeof envelope.envelope_id !== 'string') return;
    let acknowledged = false;
    const ack = payload => {
      if (acknowledged) return;
      acknowledged = true;
      if (ws.readyState === 1) ws.send(JSON.stringify({ envelope_id: envelope.envelope_id,
        ...(envelope.accepts_response_payload && payload ? { payload } : {}) }));
    };
    const durableEvent = envelope.type === 'events_api';
    const deadline = durableEvent ? undefined : setTimeout(() => ack(), ackMs);
    if (!envelope.accepts_response_payload && !durableEvent) ack();
    try {
      if (!['slash_commands', 'interactive', 'events_api'].includes(envelope.type)) { ack(); return; }
      const now = Date.now();
      for (const [key, entry] of pending) if (now - entry.at > 300000) pending.delete(key);
      let entry = pending.get(envelope.envelope_id);
      if (!entry) {
        if (pending.size >= 5000) pending.delete(pending.keys().next().value);
        entry = { at: now, work: forward({ envelope_id: envelope.envelope_id, payload: envelope.payload }) };
        pending.set(envelope.envelope_id, entry);
      }
      ack(await entry.work);
    } catch { pending.delete(envelope.envelope_id); if (!durableEvent) ack(); log('Slack relay upstream unavailable'); }
    finally { clearTimeout(deadline); }
  }
  async function connect() {
    if (stopped || connecting) return;
    connecting = true;
    try {
      const res = await fetchImpl(connectionsUrl, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15000) });
      const body = await res.json();
      if (!res.ok || !body.ok || !body.url) throw new Error('Connection unavailable');
      if (stopped) return;
      const ws = new WebSocketImpl(body.url); socket = ws;
      ws.addEventListener('open', () => { attempts = 0; log('Slack relay connected'); void heartbeat(true); });
      ws.addEventListener('message', event => { void receive(ws, event.data); });
      ws.addEventListener('error', () => { ws.close(); });
      ws.addEventListener('close', () => { if (socket === ws) { void heartbeat(false); schedule(); } });
    } catch { log('Slack relay reconnecting'); schedule(); }
    finally { connecting = false; }
  }
  const timer = setInterval(() => { if (socket?.readyState === 1) void heartbeat(true); }, heartbeatMs);
  void connect();
  return { active: true, stop() { stopped = true; clearInterval(timer); clearTimeout(reconnectTimer); socket?.close(); pending.clear(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const relay = startRelay({ token: process.env.SLACK_APP_TOKEN, secret: process.env.SLACK_INTERNAL_SECRET,
      anonKey: process.env.ANON_KEY, log: message => console.log(message) });
    process.once('SIGTERM', () => relay.stop()); process.once('SIGINT', () => relay.stop());
  } catch { console.error('Slack relay configuration incomplete'); process.exitCode = 1; }
}
