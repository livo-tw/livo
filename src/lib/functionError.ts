/**
 * The machine code of a failed functions.invoke call, from either backend: the
 * cloud client puts it on error.code; supabase-js keeps the response on
 * error.context. Returns '' when there is none.
 */
export async function functionErrorCode(error: unknown, data?: unknown): Promise<string> {
  const fromData = (data as { error?: unknown } | null)?.error;
  if (typeof fromData === 'string') return fromData;
  const failure = error as { code?: unknown; context?: unknown } | null;
  if (typeof failure?.code === 'string') return failure.code;
  if (typeof Response !== 'undefined' && failure?.context instanceof Response) {
    try {
      const payload = await failure.context.clone().json() as { error?: unknown };
      if (typeof payload.error === 'string') return payload.error;
      const nested = payload.error as { code?: unknown } | undefined;
      if (typeof nested?.code === 'string') return nested.code;
    } catch { /* not JSON */ }
  }
  return '';
}
