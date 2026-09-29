export interface WebhookConfig {
  enabled: boolean;
  url: string;
  secret: string;
  events: string[];
}

// Module-level copy of the active config so dispatch sites outside the
// TaskContext tree (e.g. the comment hook) can fire events without
// prop-drilling. Set at initial load (useInitialLoad) and on save
// (useIntegrations), mirroring webhookConfigRef.
let activeConfig: WebhookConfig | null = null;
export function setWebhookConfig(cfg: WebhookConfig | null): void {
  activeConfig = cfg;
}
export function getWebhookConfig(): WebhookConfig | null {
  return activeConfig;
}

async function hmacSignature(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Fire-and-forget webhook trigger. Silently swallows errors so task
 * updates are never blocked by a misconfigured webhook endpoint.
 * Signs the payload with HMAC-SHA256 when a secret is configured.
 */
export async function triggerWebhook(
  config: WebhookConfig,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  if (!config.enabled || !config.url || !config.events.includes(event)) return;

  const payload = { event, ...data, timestamp: new Date().toISOString() };
  const body = JSON.stringify(payload);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (config.secret) {
    try {
      const sig = await hmacSignature(config.secret, body);
      headers['X-LIVO-Signature'] = `sha256=${sig}`;
    } catch {
      // Signature generation failed; send unsigned rather than drop the event
    }
  }

  try {
    await fetch(config.url, { method: 'POST', headers, body });
  } catch {
    console.error('[LIVO] Webhook trigger failed for event:', event);
  }
}
