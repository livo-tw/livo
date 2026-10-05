import { supabase } from '@/integrations/supabase/client';

// Cloud-beta storage quota discovery. check_license piggybacks the caller's
// workspaces row (workspace_quota) for beta tenants; default-workspace /
// self-host / demo builds get no field and have no storage cap.
// Cached per page load — the limit only changes by seller action.

export interface WorkspaceStorageQuota {
  limitBytes: number;
  /** The server's own counter, the number the limit is enforced against. */
  usedBytes: number | null;
}

let cached: Promise<WorkspaceStorageQuota | null> | undefined;

async function loadQuota(): Promise<WorkspaceStorageQuota | null> {
  try {
    const { data } = await supabase.rpc('check_license');
    const quota = (data as { workspace_quota?: { storage_limit_mb?: unknown; storage_used_bytes?: unknown } } | null)?.workspace_quota;
    const mb = quota && typeof quota.storage_limit_mb === 'number' ? quota.storage_limit_mb : null;
    if (!mb || mb <= 0) return null;
    return { limitBytes: mb * 1024 * 1024, usedBytes: typeof quota?.storage_used_bytes === 'number' ? quota.storage_used_bytes : null };
  } catch {
    return null;
  }
}

/** This workspace's storage quota, or null when there is none (self-host, demo). */
export function getWorkspaceStorageQuota({ refresh = false }: { refresh?: boolean } = {}): Promise<WorkspaceStorageQuota | null> {
  if (refresh || !cached) cached = loadQuota();
  return cached;
}

/** Effective storage limit in BYTES for this workspace, or null when there is none. */
export async function getWorkspaceStorageLimitBytes(): Promise<number | null> {
  return (await getWorkspaceStorageQuota())?.limitBytes ?? null;
}
