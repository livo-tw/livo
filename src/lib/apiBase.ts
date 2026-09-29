// Backend endpoint helpers for the few call sites that bypass the client SDK
// (keepalive beacons, raw fetch to functions). Works for both backends:
// - Cloudflare Worker (VITE_API_URL set) — the current backend
// - legacy Supabase (VITE_SUPABASE_* set) — kept until final cleanup

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';
export const USE_CF_BACKEND = !!API_URL;

/** URL for a backend function (legacy Edge Function name). */
export function fnUrl(name: string): string {
  if (USE_CF_BACKEND) return `${API_URL}/api/functions/${name}`;
  // Self-host builds route through the customer's own Supabase gateway
  // (VITE_SUPABASE_URL, e.g. http://localhost:8000) — same as rpcUrl below.
  // Never *.supabase.co: that cloud project no longer exists, and a customer
  // install must not call external hosts.
  return `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/${name}`;
}

/** URL for an RPC function (legacy PostgREST rpc path). */
export function rpcUrl(fn: string): string {
  if (USE_CF_BACKEND) return `${API_URL}/api/rpc/${fn}`;
  return `${import.meta.env.VITE_SUPABASE_URL}/rest/v1/rpc/${fn}`;
}

/** Best-effort synchronous access-token read for beacon/keepalive calls. */
export function getAccessTokenSync(): string | null {
  try {
    if (USE_CF_BACKEND) {
      const s = localStorage.getItem('livo-auth');
      if (s) return (JSON.parse(s)?.access_token as string) ?? null;
      return null;
    }
    const supabaseUrl = (import.meta.env.VITE_SUPABASE_URL as string) || '';
    const projectId =
      import.meta.env.VITE_SUPABASE_PROJECT_ID || new URL(supabaseUrl).hostname.split('.')[0];
    const s = localStorage.getItem(`sb-${projectId}-auth-token`);
    if (s) return (JSON.parse(s)?.access_token as string) ?? null;
  } catch {
    // fall through
  }
  return null;
}
