import type { Env } from './env';

// Password-guess throttle for /api/auth/login and change-password.
// Counters live in auth_login_attempts (one row per key, confirmed failures
// only); in-flight checks hold expiring auth_login_reservations leases.
//
//   pair:<email>|<source>  5 failures → this email is locked for 15 min from
//                          this source only. Somebody guessing a known email
//                          from elsewhere cannot lock its owner out.
//   ip:<source>            20 failures across emails → the source is locked
//                          for 15 min (password spraying).
//   email:<email>          no hard lock. At most 10 password checks in flight,
//                          and after 50 failures in a window from all sources
//                          together, each further failure pauses the email for
//                          30 s (a distributed guess budget, not a lockout).
// A correct password from a source that is not throttled settles as success,
// which also clears the email's pause and the pair's failures.
const WINDOW_MS = 15 * 60_000;
const LEASE_MS = 2 * 60_000;
const PAIR_LIMIT = 5;
const IP_LIMIT = 20;
const EMAIL_INFLIGHT_LIMIT = 10;
const EMAIL_SOFT_LIMIT = 50;
const EMAIL_BACKOFF_MS = 30_000;
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

/** Every reservation belongs to particular counter windows and expires. */
export async function reserveLoginAttempt(env: Store, email: string, ip: string | null): Promise<LoginReservation> {
  const now = Date.now(), time = new Date(now).toISOString();
  const cutoff = new Date(now - WINDOW_MS).toISOString();
  const id = crypto.randomUUID(), emailKey = `email:${email}`, ipKey = ip ? `ip:${ip}` : null;
  // The source bucket never contains '|', so the last separator is unambiguous.
  const pairKey = `pair:${email}|${ip ?? 'local'}`;
  // A hard-locked key restarts once its lock has passed; any key restarts after an idle window.
  const reopenLocked = '(locked_until IS NULL AND window_start<=?3) OR locked_until<=?2';
  // The email pause must not erase its window: the budget resets only with the window.
  const reopenEmail = 'window_start<=?3 AND (locked_until IS NULL OR locked_until<=?2)';
  // Counters plus live leases of this exact window; reads and the lease insert
  // run in one D1 batch transaction, so no stale-read burst.
  const ipAllowed = (now: string) => `i.locked_until IS NULL AND i.failures+(SELECT count(*) FROM auth_login_reservations r
    WHERE r.ip_key=i.key AND r.ip_window=i.window_start AND r.expires_at>${now})<${IP_LIMIT}`;
  const pairAllowed = `p.locked_until IS NULL AND p.failures+(SELECT count(*) FROM auth_login_reservations r
    WHERE r.pair_key=p.key AND r.pair_window=p.window_start AND r.expires_at>?5)<${PAIR_LIMIT}`;
  const emailAllowed = `(e.locked_until IS NULL OR e.locked_until<=?5) AND (SELECT count(*) FROM auth_login_reservations r
    WHERE r.email_key=e.key AND r.expires_at>?5)<${EMAIL_INFLIGHT_LIMIT}`;
  const statements: D1PreparedStatement[] = [];
  if (ipKey) statements.push(env.DB.prepare(`INSERT INTO auth_login_attempts(key,failures,window_start)
    VALUES (?1,0,?2) ON CONFLICT(key) DO UPDATE SET failures=0,window_start=?2,locked_until=NULL
    WHERE ${reopenLocked}`).bind(ipKey, time, cutoff));
  // When the source is blocked these SELECTs produce no row at all. A client
  // rotating emails cannot grow D1 after exhausting its source budget.
  for (const [key, reopen] of [[pairKey, reopenLocked], [emailKey, reopenEmail]]) {
    statements.push(env.DB.prepare(`INSERT INTO auth_login_attempts(key,failures,window_start)
      SELECT ?1,0,?2 WHERE ?4 IS NULL OR EXISTS(SELECT 1 FROM auth_login_attempts i WHERE i.key=?4 AND ${ipAllowed('?2')})
      ON CONFLICT(key) DO UPDATE SET failures=0,window_start=?2,locked_until=NULL
      WHERE ${reopen}`).bind(key, time, cutoff, ipKey));
  }
  statements.push(env.DB.prepare(`INSERT INTO auth_login_reservations(id,email_key,email_window,pair_key,pair_window,ip_key,ip_window,expires_at)
    SELECT ?1,e.key,e.window_start,p.key,p.window_start,?4,i.window_start,?6 FROM auth_login_attempts e
    JOIN auth_login_attempts p ON p.key=?3
    LEFT JOIN auth_login_attempts i ON i.key=?4
    WHERE e.key=?2 AND ${emailAllowed} AND ${pairAllowed} AND (?4 IS NULL OR (${ipAllowed('?5')})) RETURNING id`
  ).bind(id, emailKey, pairKey, ipKey, time, new Date(now + LEASE_MS).toISOString()));
  // Same snapshot as reservation: distinguish a lock or pause from temporary capacity.
  statements.push(env.DB.prepare('SELECT locked_until FROM auth_login_attempts WHERE key IN (?1,?2,?3)').bind(emailKey, pairKey, ipKey));
  const results = await env.DB.batch<{ id?: string; locked_until?: string | null }>(statements);
  if (results[results.length - 2].results.length) return { locked: false, id };
  const lockUntil = Math.max(0, ...results[results.length - 1].results.map(r => r.locked_until ? Date.parse(r.locked_until) : 0));
  return { locked: true, retryAfterS: Math.max(1, Math.ceil((lockUntil - now) / 1000)) };
}

/** Exactly-once settlement. In-flight requests never count as confirmed failures. */
export async function finishLoginAttempt(env: Store, id: string, outcome: 'success' | 'failure' | 'cancel'): Promise<boolean> {
  const now = Date.now(), time = new Date(now).toISOString();
  const lockUntil = new Date(now + WINDOW_MS).toISOString(), pauseUntil = new Date(now + EMAIL_BACKOFF_MS).toISOString();
  const statements: D1PreparedStatement[] = [];
  for (const kind of ['email', 'pair', 'ip'] as const) {
    if (outcome === 'cancel' || (outcome === 'success' && kind === 'ip')) continue;
    const lock = outcome === 'success' ? 'NULL'
      : kind === 'email' ? `CASE WHEN failures+1>=${EMAIL_SOFT_LIMIT} THEN ?3 ELSE locked_until END`
      : `CASE WHEN failures+1>=${kind === 'pair' ? PAIR_LIMIT : IP_LIMIT} THEN COALESCE(locked_until,?3) ELSE locked_until END`;
    statements.push(env.DB.prepare(`UPDATE auth_login_attempts SET
      failures=${outcome === 'success' ? '0' : 'failures+1'}, locked_until=${lock}
      WHERE EXISTS(SELECT 1 FROM auth_login_reservations r WHERE r.id=?1 AND r.expires_at>?2
        AND r.${kind}_key=auth_login_attempts.key AND r.${kind}_window=auth_login_attempts.window_start)`
    ).bind(...(outcome === 'success' ? [id, time] : [id, time, kind === 'email' ? pauseUntil : lockUntil])));
  }
  statements.push(env.DB.prepare('DELETE FROM auth_login_reservations WHERE id=? RETURNING expires_at').bind(id));
  const results = await env.DB.batch<{ expires_at: string }>(statements);
  const lease = results[results.length - 1].results[0];
  return !!lease && lease.expires_at > time;
}

/** Bounded indexed cleanup; active leases and non-expired locks survive. */
export async function pruneLoginAttempts(env: Store): Promise<void> {
  const now = Date.now(), time = new Date(now).toISOString();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_login_reservations WHERE id IN
      (SELECT id FROM auth_login_reservations WHERE expires_at<=? ORDER BY expires_at LIMIT 500)`).bind(time),
    env.DB.prepare(`DELETE FROM auth_login_attempts WHERE key IN
      (SELECT a.key FROM auth_login_attempts a WHERE a.window_start<=?1 AND (a.locked_until IS NULL OR a.locked_until<=?2)
        AND NOT EXISTS(SELECT 1 FROM auth_login_reservations r WHERE r.expires_at>?2 AND (r.email_key=a.key OR r.pair_key=a.key OR r.ip_key=a.key))
        ORDER BY a.window_start LIMIT 500)`).bind(new Date(now - WINDOW_MS).toISOString(), time),
  ]);
}
