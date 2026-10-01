/**
 * Cloud-safe sales-demo mode (?demo=pro).
 *
 * Distinct from the dev-only ?plan=pro override in LicenseContext:
 *  - ?plan=pro  → dev / VITE_LOCAL_MODE only (developer convenience)
 *  - ?demo=pro  → works on the live cloud build too (sales preview)
 *
 * When active, the whole app runs against the in-memory mock Supabase
 * client (see client.ts). That means:
 *  - every read returns rich seed data
 *  - every write mutates in-memory only — never hits Supabase Cloud,
 *    never consumes API/quota, gone on tab close
 *  - completely isolated from the real HMAC license activation path
 *
 * The flag is mirrored into sessionStorage so it survives SPA route
 * changes and the /auth redirect, and dies when the tab closes
 * (per-tab, never localStorage — nothing leaks to a real user).
 */

const DEMO_FLAG_KEY = 'livo_demo_pro';

function detect(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    const params = new URLSearchParams(window.location.search);
    if (params.get('demo') === 'pro') {
      sessionStorage.setItem(DEMO_FLAG_KEY, '1');
      return true;
    }
    return sessionStorage.getItem(DEMO_FLAG_KEY) === '1';
  } catch {
    // ?demo=pro present but storage blocked — still honor the URL.
    try {
      return new URLSearchParams(window.location.search).get('demo') === 'pro';
    } catch {
      return false;
    }
  }
}

/**
 * Evaluated once at module load. client.ts reads this to decide mock
 * vs real client, so it must be a stable constant for the page's life.
 */
export const IS_DEMO_PRO: boolean = detect();

/** Leave demo mode: clear the flag and reload into the plain app. */
export function exitDemoMode(): void {
  try {
    sessionStorage.removeItem(DEMO_FLAG_KEY);
  } catch {
    /* ignore */
  }
  window.location.href = import.meta.env.BASE_URL;
}
