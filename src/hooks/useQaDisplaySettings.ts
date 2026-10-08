import { useEffect, useState } from 'react';
import type { QaClient } from '@/lib/qa/client';
import { validateQaDisplaySettings, type QaDisplaySettings } from '@/lib/qa/displaySettings';

/** Never overwrite an unknown server preference with a successful default read. */
export function useQaDisplaySettings(client: Pick<QaClient, 'getDisplaySettings'>, scopeKey = '') {
  const [configuration, setConfiguration] = useState<QaDisplaySettings | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  const [loadedScope, setLoadedScope] = useState({ client, scopeKey });
  useEffect(() => {
    const controller = new AbortController();
    setConfiguration(null); setError(null); setLoadedScope({ client, scopeKey });
    void Promise.resolve().then(() => client.getDisplaySettings(controller.signal))
      .then(value => { if (!controller.signal.aborted) setConfiguration(validateQaDisplaySettings(value)); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [client, revision, scopeKey]);
  const current = loadedScope.client === client && loadedScope.scopeKey === scopeKey;
  return { configuration: current ? configuration : null, error: current ? error : null, retry: () => setRevision(value => value + 1) };
}
