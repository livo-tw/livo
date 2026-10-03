/** Privileged retention maintenance. Never construct this repository from a user session. */
export const IMPORT_CLEANUP_LEASE_MS = 10 * 60 * 1000;
export const IMPORT_CLEANUP_SETTLE_MS = 15 * 60 * 1000;
export const IMPORT_CLEANUP_BATCH = 20;
export const IMPORT_CLEANUP_FILE_LIMIT = 1000;

export interface ImportCleanupClaim {
  id: string;
  workspace_id: string;
  actor_id: string;
  lease_token: string;
}

export interface ImportCleanupRepository {
  /** Atomically fence the expired job's version and claim a bounded, expiring lease. */
  claim(now: string, leaseUntil: string, token: string, limit: number): Promise<ImportCleanupClaim[]>;
  /** List only the exact actor/job storage prefix, including abandoned parser-run files. */
  files(job: ImportCleanupClaim): Promise<string[]>;
  /** All source references in this workspace, irrespective of actor, capability or page ACL. */
  retained(job: ImportCleanupClaim, keys: string[]): Promise<string[]>;
  owns(job: ImportCleanupClaim, now: string): Promise<boolean>;
  remove(job: ImportCleanupClaim, keys: string[]): Promise<number>;
  /** First sweep removes private job data; a later sweep removes the minimal tombstone. */
  finish(job: ImportCleanupClaim, now: string, settledBefore: string, nextSweep: string): Promise<boolean>;
}

export interface ImportCleanupSummary {
  claimed: number;
  completed: number;
  removed: number;
  retained: number;
  failed: number;
  lost_lease: number;
}

export function importJobPrefix(job: Pick<ImportCleanupClaim, 'id' | 'actor_id'>): string {
  const segment = /^[A-Za-z0-9_.-]{1,100}$/;
  if (!segment.test(job.id) || !segment.test(job.actor_id) || job.id === '.' || job.id === '..' || job.actor_id === '.' || job.actor_id === '..') {
    throw new Error('invalid_cleanup_prefix');
  }
  return `${job.actor_id}/${job.id}/`;
}

export async function runImportCleanup(
  repository: ImportCleanupRepository,
  options: { now?: () => number; token?: string; limit?: number } = {},
): Promise<ImportCleanupSummary> {
  const now = options.now || Date.now;
  const started = now();
  const summary: ImportCleanupSummary = { claimed: 0, completed: 0, removed: 0, retained: 0, failed: 0, lost_lease: 0 };
  const claims = await repository.claim(new Date(started).toISOString(),
    new Date(started + IMPORT_CLEANUP_LEASE_MS).toISOString(), options.token || crypto.randomUUID(),
    Math.max(1, Math.min(IMPORT_CLEANUP_BATCH, options.limit || IMPORT_CLEANUP_BATCH)));
  summary.claimed = claims.length;
  for (const claim of claims) {
    try {
      const prefix = importJobPrefix(claim);
      const keys = [...new Set(await repository.files(claim))];
      if (keys.length > IMPORT_CLEANUP_FILE_LIMIT || keys.some(key => !key.startsWith(prefix) || key.includes('/../') || key.includes('\\'))) {
        throw new Error('invalid_cleanup_objects');
      }
      const retained = new Set(await repository.retained(claim, keys));
      summary.retained += keys.filter(key => retained.has(key)).length;
      const remove = keys.filter(key => !retained.has(key));
      let lost = false;
      for (let at = 0; at < remove.length; at += 100) {
        if (!await repository.owns(claim, new Date(now()).toISOString())) { lost = true; break; }
        const batch = remove.slice(at, at + 100);
        summary.removed += await repository.remove(claim, batch);
      }
      if (lost) { summary.lost_lease++; continue; }
      const stamp = now();
      if (await repository.finish(claim, new Date(stamp).toISOString(),
        new Date(stamp - IMPORT_CLEANUP_SETTLE_MS).toISOString(),
        new Date(stamp + IMPORT_CLEANUP_SETTLE_MS).toISOString())) summary.completed++;
      else summary.lost_lease++;
    } catch {
      // Keep the expired job/lease for a later retry. Never log private paths or document data.
      summary.failed++;
    }
  }
  return summary;
}
