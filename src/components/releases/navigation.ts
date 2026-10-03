/** Pending release forms are independent of the optional QA capability. */
const guards = new Map<symbol, { url: string; notify: () => void }>();
export const hasReleaseNavigationGuard = () => guards.size > 0;
export const notifyReleaseNavigationBlocked = () => { guards.values().next().value?.notify(); };
function block(event: Event) {
  const guard = guards.values().next().value;
  if (!guard || (event.type === 'popstate' && new URL(window.location.href).pathname !== new URL(guard.url).pathname)) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (window.location.href !== guard.url) window.history.replaceState(window.history.state, '', guard.url);
  guard.notify();
}
export function clearReleaseNavigationGuards() {
  guards.clear(); window.removeEventListener('popstate', block, true); window.removeEventListener('livo:qa-navigation', block, true); window.removeEventListener('livo:qa-abort', clearReleaseNavigationGuards, true);
}
export function registerReleaseNavigationGuard(notify: () => void) {
  if (!guards.size) { window.addEventListener('popstate', block, true); window.addEventListener('livo:qa-navigation', block, true); window.addEventListener('livo:qa-abort', clearReleaseNavigationGuards, true); }
  const key = Symbol('release-form'); guards.set(key, { url: window.location.href, notify });
  return () => { guards.delete(key); if (!guards.size) clearReleaseNavigationGuards(); };
}
