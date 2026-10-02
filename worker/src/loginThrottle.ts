import type { Env } from './env';

const WINDOW_MS = 15 * 60_000;
const LEASE_MS = 2 * 60_000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 20;
type Store = Pick<Env, 'DB'>;
export type LoginReservation = { locked: false; id: string } | { locked: true; retryAfterS: number };

/** Only edge-supplied CF-Connecting-IP is trusted. Never fall back to XFF. */
export function loginIpBucket(raw: string): string | null {
  if (!raw || raw.length > 64) return null;
  const value = raw.trim().toLowerCase();
  if (!value.includes(':')) {
    const parts = value.split('.');
    return parts.length === 4 && parts.every(p => /^\d{1,3}$/.test(p) && Number(p) <= 255)
      ? parts.map(Number).join('.') : null;
  }
  try {
    // The URL parser validates and canonicalizes compressed and embedded IPv4 forms.
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const [head, tail] = normalized.split('::');
    const left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
    const groups = (tail === undefined ? left : [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]).map(p => parseInt(p, 16));
    if (groups.length !== 8) return null;
    if (groups.slice(0, 5).every(p => p === 0) && groups[5] === 0xffff)
      return [groups[6] >> 8, groups[6] & 255, groups[7] >> 8, groups[7] & 255].join('.');
    return `${groups.slice(0, 4).map(p => p.toString(16)).join(':')}::/64`;
  } catch { return null; }
}

export function loginSourceIp(url: string, raw: string | undefined): string | null {
  if (raw) {
    const ip = loginIpBucket(raw);
    if (ip) return ip;
    throw new Error('login_source_unavailable');
  }
  // Explicit loopback development only. Missing visitor headers in production
  // must not silently turn off password-spray protection.
  if (['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname)) return null;
  throw new Error('login_source_unavailable');
}

/** Every reservation belongs to a particular counter window and expires. */
export async function reserveLoginAttempt(env: Store, email: string, ip: string | null): Promise<LoginReservation> {
  const now = Date.now(), time = new Date(now).toISOString();
  const cutoff = new Date(now - WINDOW_MS).toISOString();
  const id = crypto.randomUUID(), emailKey = `email:${email}`, ipKey = ip ? `ip:${ip}` : null;
  const open = (key: string) => env.DB.prepare(`INSERT INTO auth_login_attempts(key,failures,window_start)
    VALUES (?1,0,?2) ON CONFLICT(key) DO UPDATE SET failures=0,window_start=?2,locked_until=NULL
    WHERE (locked_until IS NULL AND window_start<=?3) OR locked_until<=?2`).bind(key,time,cutoff);
  // Both predicates count live leases in this exact window. Counter reads and
  // the lease insertion run in one D1 batch transaction, so no stale-read burst.
  const ipAllowed = `i.locked_until IS NULL AND i.failures+(SELECT count(*) FROM auth_login_reservations r
    WHERE r.ip_key=i.key AND r.ip_window=i.window_start AND r.expires_at>?4)<${IP_LIMIT}`;
  const emailAllowed = `e.locked_until IS NULL AND e.failures+(SELECT count(*) FROM auth_login_reservations r
    WHERE r.email_key=e.key AND r.email_window=e.window_start AND r.expires_at>?4)<${EMAIL_LIMIT}`;
  const statements: D1PreparedStatement[] = [];
  if (ipKey) statements.push(open(ipKey));
  // When IP is blocked, this SELECT produces no email row at all. A client
  // rotating unknown addresses cannot grow D1 after exhausting its IP budget.
  statements.push(env.DB.prepare(`INSERT INTO auth_login_attempts(key,failures,window_start)
    SELECT ?1,0,?2 WHERE ?5 IS NULL OR EXISTS(SELECT 1 FROM auth_login_attempts i WHERE i.key=?5 AND ${ipAllowed})
    ON CONFLICT(key) DO UPDATE SET failures=0,window_start=?2,locked_until=NULL
    WHERE (locked_until IS NULL AND window_start<=?3) OR locked_until<=?2`).bind(emailKey,time,cutoff,time,ipKey));
  statements.push(env.DB.prepare(`INSERT INTO auth_login_reservations(id,email_key,email_window,ip_key,ip_window,expires_at)
    SELECT ?1,e.key,e.window_start,?3,i.window_start,?5 FROM auth_login_attempts e
    LEFT JOIN auth_login_attempts i ON i.key=?3
    WHERE e.key=?2 AND ${emailAllowed} AND (?3 IS NULL OR (${ipAllowed})) RETURNING id`
  ).bind(id,emailKey,ipKey,time,new Date(now+LEASE_MS).toISOString()));
  // Same snapshot as reservation: distinguish hard lock from temporary capacity.
  statements.push(env.DB.prepare('SELECT locked_until FROM auth_login_attempts WHERE key IN (?1,?2)').bind(emailKey,ipKey));
  const results = await env.DB.batch<{id?:string;locked_until?:string|null}>(statements);
  if (results[results.length-2].results.length) return {locked:false,id};
  const lockUntil = Math.max(0,...results[results.length-1].results.map(r=>r.locked_until ? Date.parse(r.locked_until) : 0));
  return {locked:true,retryAfterS:Math.max(1,Math.ceil((lockUntil-now)/1000))};
}

/** Exactly-once settlement. In-flight requests never count as confirmed failures. */
export async function finishLoginAttempt(env: Store, id: string, outcome: 'success'|'failure'|'cancel'): Promise<boolean> {
  const now=Date.now(), time=new Date(now).toISOString(), lockUntil=new Date(now+WINDOW_MS).toISOString();
  const statements: D1PreparedStatement[]=[];
  for (const [kind,limit] of [['email',EMAIL_LIMIT],['ip',IP_LIMIT]] as const) {
    if (outcome==='cancel' || (outcome==='success' && kind==='ip')) continue;
    const keyColumn=`${kind}_key`, windowColumn=`${kind}_window`;
    statements.push(env.DB.prepare(`UPDATE auth_login_attempts SET
      failures=${outcome==='success'?'0':'failures+1'},
      locked_until=${outcome==='success'?'NULL':`CASE WHEN failures+1>=${limit} THEN COALESCE(locked_until,?3) ELSE locked_until END`}
      WHERE EXISTS(SELECT 1 FROM auth_login_reservations r WHERE r.id=?1 AND r.expires_at>?2
        AND r.${keyColumn}=auth_login_attempts.key AND r.${windowColumn}=auth_login_attempts.window_start)`
    ).bind(...(outcome==='success'?[id,time]:[id,time,lockUntil])));
  }
  statements.push(env.DB.prepare('DELETE FROM auth_login_reservations WHERE id=? RETURNING expires_at').bind(id));
  const results=await env.DB.batch<{expires_at:string}>(statements);
  const lease=results[results.length-1].results[0];
  return !!lease && lease.expires_at>time;
}

/** Bounded indexed cleanup; active leases and non-expired locks survive. */
export async function pruneLoginAttempts(env: Store): Promise<void> {
  const now=Date.now(), time=new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_login_reservations WHERE id IN
      (SELECT id FROM auth_login_reservations WHERE expires_at<=? ORDER BY expires_at LIMIT 500)`).bind(time),
    env.DB.prepare(`DELETE FROM auth_login_attempts WHERE key IN
      (SELECT a.key FROM auth_login_attempts a WHERE a.window_start<=?1 AND (a.locked_until IS NULL OR a.locked_until<=?2)
        AND NOT EXISTS(SELECT 1 FROM auth_login_reservations r WHERE r.expires_at>?2 AND (r.email_key=a.key OR r.ip_key=a.key))
        ORDER BY a.window_start LIMIT 500)`).bind(new Date(now-WINDOW_MS).toISOString(),time),
  ]);
}
