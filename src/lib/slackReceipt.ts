/** Transport success alone is not a Slack delivery receipt. */
export function requireSlackReceipt(result: { data?: unknown; error?: unknown }): void {
  if (result.error) throw result.error instanceof Error ? result.error : new Error('Slack request failed');
  const data = result.data as { success?: boolean; error?: string } | null;
  if (data?.error) throw new Error(data.error);
  if (data?.success !== true) throw new Error('Slack delivery was not confirmed');
}
