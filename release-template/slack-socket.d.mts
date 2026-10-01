export function startRelay(options?: {
  token?: string; secret?: string; anonKey?: string; upstream?: string; connectionsUrl?: string;
  WebSocketImpl?: typeof WebSocket; fetchImpl?: typeof fetch; log?: (message: string) => void;
  reconnectMs?: number; heartbeatMs?: number; ackMs?: number;
}): { active: boolean; stop(): void };
