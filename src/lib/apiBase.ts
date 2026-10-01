// Backend endpoint helpers for the few call sites that bypass the client SDK
// (keepalive beacons, raw fetch to functions). Works for both backends:
// - Cloudflare Worker (VITE_API_URL set) — the current backend
// - legacy Supabase (VITE_SUPABASE_* set) — kept until final cleanup

import { SUPABASE_URL, supabaseAuthStorageKey } from '@/lib/gatewayUrl';

export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) || '';
export const USE_CF_BACKEND = !!API_URL;

/** URL for a backend function (legacy Edge Function name). */
export function fnUrl(name: string): string {
  if (USE_CF_BACKEND) return `${API_URL}/api/functions/${name}`;
  // Self-host builds route through the customer's own Supabase gateway
  // (VITE_SUPABASE_URL, e.g. http://localhost:8000, resolved for the visiting
  // browser by gatewayUrl.ts) — same as rpcUrl below.
  // Never *.supabase.co: that cloud project no longer exists, and a customer
  // install must not call external hosts.
  return `${SUPABASE_URL}/functions/v1/${name}`;
}

/** URL for an RPC function (legacy PostgREST rpc path). */
export function rpcUrl(fn: string): string {
  if (USE_CF_BACKEND) return `${API_URL}/api/rpc/${fn}`;
  return `${SUPABASE_URL}/rest/v1/rpc/${fn}`;
}

/** Best-effort synchronous access-token read for beacon/keepalive calls. */
export function getAccessTokenSync(): string | null {
  try {
    if (USE_CF_BACKEND) {
      const s = localStorage.getItem('livo-auth');
      if (s) return (JSON.parse(s)?.access_token as string) ?? null;
      return null;
    }
    // The same key supabase-js stores the session under (derived from the
    // resolved gateway origin, including Docker's same-origin proxy).
    const s = localStorage.getItem(supabaseAuthStorageKey(SUPABASE_URL));
    if (s) return (JSON.parse(s)?.access_token as string) ?? null;
  } catch {
    // fall through
  }
  return null;
}
