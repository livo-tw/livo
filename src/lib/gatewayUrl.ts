// API gateway URL for Docker self-host builds (the Supabase client path).
//
// The self-host bundle bakes the gateway as http://localhost:<port>
// (.env.customer; install.sh / install.ps1 patch the port). That only works in a
// browser on the server itself: a colleague opening http://<server>:3000/demo/
// would make their own browser call its own localhost. So when the baked host is
// a loopback address and the page is not, the page's host is used instead, with
// the baked scheme and port. A real host in VITE_SUPABASE_URL is used as is.

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function currentPageHostname(): string {
  return typeof window !== 'undefined' && window.location ? window.location.hostname : '';
}

/** `raw` with its loopback host swapped for the page's host (see above). */
export function resolveGatewayUrl(raw: string, pageHostname: string = currentPageHostname()): string {
  if (!raw) return raw;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  if (!isLoopbackHost(url.hostname) || !pageHostname || isLoopbackHost(pageHostname)) return raw;
  url.hostname = pageHostname;
  const out = url.toString();
  // URL adds a trailing slash to a bare origin; the callers append paths.
  return raw.endsWith('/') ? out : out.replace(/\/$/, '');
}

/** The gateway URL this browser should call (empty when the build has none). */
export const SUPABASE_URL = resolveGatewayUrl((import.meta.env.VITE_SUPABASE_URL as string | undefined) || '');

/** supabase-js keeps the session under sb-<first host label>-auth-token. */
export function supabaseAuthStorageKey(gatewayUrl: string): string {
  return `sb-${new URL(gatewayUrl).hostname.split('.')[0]}-auth-token`;
}
