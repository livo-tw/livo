import { supabase } from '@/integrations/supabase/client';

// Cloud-beta storage quota discovery. check_license piggybacks the caller's
// workspaces row (workspace_quota) for beta tenants; default-workspace /
// self-host / demo builds get no field and keep the legacy 1 GB display
// constant. Cached per page load — the limit only changes by seller action.

let cached: number | null | undefined;

/** Effective storage limit in BYTES for this workspace, or null when the
 *  backend reports no per-workspace quota (fall back to the UI default). */
export async function getWorkspaceStorageLimitBytes(): Promise<number | null> {
  if (cached !== undefined) return cached;
  try {
    const { data } = await supabase.rpc('check_license');
    const quota = (data as { workspace_quota?: { storage_limit_mb?: unknown } } | null)?.workspace_quota;
    const mb = quota && typeof quota.storage_limit_mb === 'number' ? quota.storage_limit_mb : null;
    cached = mb && mb > 0 ? mb * 1024 * 1024 : null;
  } catch {
    cached = null;
  }
  return cached;
}
