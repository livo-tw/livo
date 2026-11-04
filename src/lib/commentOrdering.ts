export type CommentOrder = 'newest' | 'oldest';

/** Sort a display copy by creation time, keeping equal timestamps deterministic. */
export function sortComments<T extends { id: string; createdAt: string }>(
  comments: readonly T[],
  order: CommentOrder = 'newest',
): T[] {
  return [...comments].sort((a, b) => {
    const aTime = Date.parse(a.createdAt);
    const bTime = Date.parse(b.createdAt);
    const aValid = Number.isFinite(aTime);
    const bValid = Number.isFinite(bTime);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (aValid && aTime !== bTime) return order === 'oldest' ? aTime - bTime : bTime - aTime;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}
