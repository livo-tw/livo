/**
 * Generate a collision-resistant ID with a prefix.
 * Replaces the `${prefix}_${Date.now()}` pattern with crypto.randomUUID().
 */
export const generateId = (prefix: string): string =>
  `${prefix}_${crypto.randomUUID()}`;
