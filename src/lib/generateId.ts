/**
 * A random RFC 4122 version-4 UUID.
 *
 * crypto.randomUUID() exists only in secure contexts (HTTPS or localhost). A
 * self-hosted install opened as http://<server>:3000 is not one, so there it
 * is undefined and every call threw "crypto.randomUUID is not a function".
 * crypto.getRandomValues() works in every context, so build the UUID from it.
 * Use this instead of calling crypto.randomUUID() directly in browser code.
 */
export function randomUUID(): string {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Generate a collision-resistant ID with a prefix, e.g. "tag_<uuid>".
 * For tables whose Docker id column is uuid (time_entries), use randomUUID().
 */
export const generateId = (prefix: string): string =>
  `${prefix}_${randomUUID()}`;
