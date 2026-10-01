// API gateway URL for Docker self-host builds (the Supabase client path).
//
// The self-host bundle bakes the gateway as http://localhost:<port>
// (.env.customer; install.sh / install.ps1 patch the port). That only works in a
// browser on the server itself: a colleague opening http://<server>:3000/demo/
// would make their own browser call its own localhost. So when the baked host is
// a loopback address and the page is not, use the page's origin. server.cjs
// proxies the API and WebSocket paths through that same port, including HTTPS
// tunnels. A real host in VITE_SUPABASE_URL is used as is.

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function currentPageOrigin(): string {
  return typeof window !== 'undefined' && window.location ? window.location.origin : '';
}

/** Use the visiting page's origin for a non-local Docker installation. */
export function resolveGatewayUrl(raw: string, pageOrigin: string = currentPageOrigin()): string {
  if (!raw) return raw;
  let url: URL;
  let page: URL;
  try {
    url = new URL(raw);
    page = new URL(pageOrigin);
  } catch {
    return raw;
  }
  if (!isLoopbackHost(url.hostname) || isLoopbackHost(page.hostname) ||
      !['http:', 'https:'].includes(page.protocol)) return raw;
  return page.origin;
}

/** The gateway URL this browser should call (empty when the build has none). */
export const SUPABASE_URL = resolveGatewayUrl((import.meta.env.VITE_SUPABASE_URL as string | undefined) || '');

/** supabase-js keeps the session under sb-<first host label>-auth-token. */
export function supabaseAuthStorageKey(gatewayUrl: string): string {
  return `sb-${new URL(gatewayUrl).hostname.split('.')[0]}-auth-token`;
}
