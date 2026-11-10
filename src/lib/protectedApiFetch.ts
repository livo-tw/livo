import { observeApiFetch } from '@/lib/apiReachability';

const PROTECTED_API_ROUTES = ['auth', 'rest', 'functions'] as const;

/** Bypass cached redirects for authenticated JSON APIs without changing the request. */
export function createProtectedApiFetch(
  gatewayUrl: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  let gateway: URL | undefined;
  try {
    const parsed = new URL(gatewayUrl);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') gateway = parsed;
  } catch { /* The SDK retains responsibility for validating its gateway. */ }
  const basePath = gateway?.pathname.replace(/\/+$/, '') || '';
  const paths = PROTECTED_API_ROUTES.map(route => `${basePath}/${route}/v1`);

  return (input, init) => {
    let protectedApi = false;
    if (gateway) {
      try {
        // Read only the URL: passing the original Request below preserves its
        // body stream, headers, credentials, redirect mode and abort signal.
        const url = typeof input === 'object' && input !== null && 'url' in input
          ? input.url : String(input);
        const target = new URL(url, typeof document === 'undefined' ? undefined : document.baseURI);
        protectedApi = target.origin === gateway.origin && paths.some(path =>
          target.pathname === path || target.pathname.startsWith(`${path}/`));
      } catch { /* Leave unsupported inputs to the native fetch implementation. */ }
    }
    // Request.cache affects HTTP-cache lookup, including previously stored
    // redirects. Response headers alone cannot prevent that old cache hit.
    // Do not add request headers or retry: a failed POST may already be committed.
    if (!protectedApi) return fetchImpl(input, init);
    const signal = init && 'signal' in init ? init.signal
      : typeof input === 'object' && input !== null && 'signal' in input ? input.signal : undefined;
    return observeApiFetch(() => fetchImpl(input, { ...init, cache: 'no-store' }), gateway?.origin, signal);
  };
}
