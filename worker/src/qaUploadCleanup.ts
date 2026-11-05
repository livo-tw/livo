/** Privileged QA-upload retention. Every object belongs to an expired reservation. */
export const QA_UPLOAD_CLEANUP_LIMIT = 25;
export const QA_UPLOAD_SETTLE_MS = 5 * 60 * 1000;
export const QA_UPLOAD_TOMBSTONE_MS = 24 * 60 * 60 * 1000;
export interface QaCleanupUpload {
  id: string;
  workspaceId: string;
  issueId: string;
  storageKey: string;
  multipartId?: string | null;
  token: string;
}
export interface QaUploadCleanupRepository {
  claim(limit: number): Promise<QaCleanupUpload[]>;
  owns(upload: QaCleanupUpload): Promise<boolean>;
  referenced(upload: QaCleanupUpload): Promise<boolean>;
  abortMultipart(upload: QaCleanupUpload): Promise<void>;
  remove(upload: QaCleanupUpload): Promise<void>;
  finish(upload: QaCleanupUpload): Promise<boolean>;
}

/** Failed deletes retain the reservation and claim for a later lease retry. */
export async function runQaUploadCleanup(repository: QaUploadCleanupRepository, limit = QA_UPLOAD_CLEANUP_LIMIT) {
  if (!Number.isInteger(limit) || limit < 1 || limit > QA_UPLOAD_CLEANUP_LIMIT) throw new Error('qa_cleanup_limit');
  const summary = { claimed: 0, removed: 0, retained: 0, failed: 0 };
  const uploads = await repository.claim(limit);
  if (uploads.length > limit) throw new Error('qa_cleanup_limit');
  for (const upload of uploads) {
    summary.claimed++;
    try {
      if (!await repository.owns(upload) || await repository.referenced(upload)) {
        summary.retained++;
        continue;
      }
      await repository.abortMultipart(upload);
      if (!await repository.owns(upload) || await repository.referenced(upload)) {
        summary.retained++;
        continue;
      }
      await repository.remove(upload);
      if (await repository.finish(upload)) summary.removed++;
      else summary.retained++;
    } catch {
      summary.failed++;
    }
  }
  return summary;
}
