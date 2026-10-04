/**
 * The link target for a URL stored by a user (GitLab MR link, comment
 * attachment, release evidence), or null when it must not be rendered as a link.
 * Only http(s) is allowed: React does not block `javascript:` hrefs, so a stored
 * `javascript:` URL would run script when clicked. Relative paths resolve against
 * the app's own origin. URLs with credentials are refused.
 */
export function safeLinkHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const base = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
    const parsed = new URL(url, base);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return url;
  } catch {
    return null;
  }
}
