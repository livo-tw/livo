interface QaNavigationGuard { url: string; notify: () => void }
const guards = new Map<symbol, QaNavigationGuard>();

export const hasQaNavigationGuard = () => guards.size > 0;
export function notifyQaNavigationBlocked() { guards.values().next().value?.notify(); }

function blockNavigation(event: Event) {
  const guard = guards.values().next().value;
  if (!guard) return;
  if (event.type === 'popstate' && new URL(window.location.href).pathname !== new URL(guard.url).pathname) return;
  event.preventDefault(); event.stopImmediatePropagation();
  // The location was captured in this same tab before navigation. Never accept a
  // caller-provided return URL or interfere with sign-out / capability teardown.
  if (window.location.href !== guard.url) window.history.replaceState(window.history.state, '', guard.url);
  guard.notify();
}
function removeListeners() {
  window.removeEventListener('livo:qa-navigation', blockNavigation, true);
  window.removeEventListener('popstate', blockNavigation, true);
  window.removeEventListener('livo:qa-abort', clearQaNavigationGuards, true);
}
export function clearQaNavigationGuards() { guards.clear(); removeListeners(); }

export function registerQaNavigationGuard(notify: () => void): () => void {
  const key = Symbol('qa-pending-operation');
  if (!guards.size) {
    window.addEventListener('livo:qa-navigation', blockNavigation, true);
    window.addEventListener('popstate', blockNavigation, true);
    window.addEventListener('livo:qa-abort', clearQaNavigationGuards, true);
  }
  guards.set(key, { url: window.location.href, notify });
  return () => { guards.delete(key); if (!guards.size) removeListeners(); };
}
