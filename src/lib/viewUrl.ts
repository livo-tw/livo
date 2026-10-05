/**
 * Query parameters that open one view. Once the user leaves that view they must
 * not stay in the address: a reload or a copied link would reopen the old page.
 */
const VIEW_PARAMS: Record<string, readonly string[]> = {
  kb: ['knowledge-base'], anchor: ['knowledge-base'], knowledge: ['knowledge-base'],
  qa: ['qa', 'my-qa'], qaCreate: ['qa', 'my-qa'],
  release: ['releases'],
};

export function clearOtherViewParams(view: string): void {
  const url = new URL(window.location.href);
  let changed = false;
  for (const [param, views] of Object.entries(VIEW_PARAMS)) {
    if (url.searchParams.has(param) && !views.includes(view)) { url.searchParams.delete(param); changed = true; }
  }
  if (changed) window.history.replaceState(window.history.state, '', url.toString());
}
