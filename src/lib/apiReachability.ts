// Transport evidence only: a JSON HTTP response does not validate a login,
// business data, or Realtime. No URL, request body, token, or user is retained.
type ApiReachability = 'unknown' | 'responded' | 'failed';
let reachability: ApiReachability = 'unknown';
let sequence = 0;
let lastSettled = 0;
const listeners = new Set<() => void>();

export const getApiReachability = (): ApiReachability => reachability;
export const subscribeApiReachability = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

function settle(value: ApiReachability, request: number) {
  if (request < lastSettled) return;
  lastSettled = request;
  if (reachability === value) return;
  reachability = value;
  listeners.forEach(listener => listener());
}

export function invalidateApiReachability() {
  // In-flight evidence from before a new offline event must not win later.
  settle('unknown', ++sequence);
}

/** Observe one existing, no-store SDK JSON request without consuming/retrying it. */
export async function observeApiFetch(
  send: () => Promise<Response>,
  expectedOrigin: string | undefined,
  signal?: AbortSignal | null,
): Promise<Response> {
  const request = ++sequence;
  try {
    const response = await send();
    const mime = response.headers?.get('content-type')?.split(';')[0].trim().toLowerCase();
    let sameApi = !!expectedOrigin;
    if (response.url) {
      try { sameApi = new URL(response.url).origin === expectedOrigin; }
      catch { sameApi = false; }
    }
    if (sameApi && !response.redirected && response.status > 0 &&
      (mime === 'application/json' || mime?.endsWith('+json'))) {
      settle('responded', request);
    }
    return response;
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    // Abort/cancellation (including an explicitly timed-out request) is local
    // to that request. An HTTP error is returned normally above, not retried.
    if (expectedOrigin && !signal?.aborted && name !== 'AbortError' &&
      (name === 'TypeError' || name === 'NetworkError')) settle('failed', request);
    throw error;
  }
}
