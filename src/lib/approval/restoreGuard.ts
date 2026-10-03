/** Ordinary JSON restore cannot reconstruct approval history and cross-table pointers. */
export function containsApprovalRestoreData(backup: unknown): boolean {
  if (!backup || typeof backup !== 'object' || Array.isArray(backup)) return false;
  const data = backup as Record<string, unknown>;
  if (Object.entries(data).some(([name,rows]) => name.startsWith('approval_') && (!Array.isArray(rows) || rows.length > 0))) return true;
  return Array.isArray(data.tasks) && data.tasks.some(task => task && typeof task === 'object' &&
    ((task as Record<string,unknown>).current_approval_id != null && (task as Record<string,unknown>).current_approval_id !== '' ||
      (task as Record<string,unknown>).approval_status != null && (task as Record<string,unknown>).approval_status !== ''));
}
