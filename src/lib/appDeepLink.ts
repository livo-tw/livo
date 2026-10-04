/** Preserve supported destinations through sign-in without accepting redirect URLs. */
export function appDeepLinkSearch(search: string): string {
  const input = new URLSearchParams(search), output = new URLSearchParams();
  // Index.tsx opens each of these destinations; anything else (tokens, redirects) is dropped.
  for (const key of ['kb', 'anchor', 'task', 'qa', 'release', 'knowledge']) {
    const value = input.get(key);
    if (value && value.length <= 200 && (key !== 'anchor' || input.has('kb'))) output.set(key, value);
  }
  const encoded = output.toString();
  return encoded ? `?${encoded}` : '';
}
