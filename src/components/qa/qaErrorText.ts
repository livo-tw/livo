/** A known server code reads as a sentence; anything else falls back to the generic text and shows the code. */
export function qaHasErrorText(t: (key: string, options?: Record<string, unknown>) => string, code: string | null | undefined): boolean {
  if (!code) return false;
  const text = t(`qa.error.${code}`, { defaultValue: '' });
  return !!text && text !== `qa.error.${code}`;
}
export function qaErrorText(t: (key: string, options?: Record<string, unknown>) => string, error: unknown): { message: string; code?: string } {
  const failure = error as { status?: number; code?: string | null } | null;
  const key = failure?.code ? `qa.error.${failure.code}` : '';
  const known = key ? t(key, { defaultValue: '' }) : '';
  if (known && known !== key) return { message: known };
  return { message: t(failure?.status === 409 ? 'qa.conflict' : 'qa.failed'), code: failure?.code || undefined };
}
