import { useEffect, useState } from 'react';
import type { QaClient } from '@/lib/qa/client';
import type { QaFieldConfiguration } from '@/lib/qa/fields';

/** A failed catalog must not silently hide configured required fields. */
export function useQaFieldConfiguration(client: Pick<QaClient, 'getFieldConfiguration'>) {
  const [configuration, setConfiguration] = useState<QaFieldConfiguration | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConfiguration(null); setError(null);
    void client.getFieldConfiguration(controller.signal)
      .then(value => { if (!controller.signal.aborted) setConfiguration(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [client, revision]);
  return { configuration, error, retry: () => setRevision(value => value + 1) };
}
