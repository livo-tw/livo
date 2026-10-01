// Members imported from Jira without an email get `<member id>@import.invalid`
// (see placeholderEmail in worker/src/functions/jiraCsv.ts): they have a name
// but no login until an admin uses 「啟用帳號」.

const PLACEHOLDER_SUFFIX = '@import.invalid';

export function isPlaceholderEmail(email: string | null | undefined): boolean {
  const e = (email || '').trim().toLowerCase();
  return !e || e.endsWith(PLACEHOLDER_SUFFIX);
}
