import { useEffect, useState } from 'react';
import type { QaClient } from '@/lib/qa/client';
import type { QaManualStateVisibility } from '@/lib/qa/manualStateVisibility';

/** A transport failure is unknown: pause only manual state choices until a fresh read succeeds. */
export function useQaManualStateVisibility(client: Pick<QaClient, 'getManualStateVisibility'>) {
  const [configuration, setConfiguration] = useState<QaManualStateVisibility | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setConfiguration(null); setError(null);
    void client.getManualStateVisibility(controller.signal)
      .then(value => { if (!controller.signal.aborted) setConfiguration(value); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure); });
    return () => controller.abort();
  }, [client, revision]);
  return { configuration, error, retry: () => setRevision(value => value + 1) };
}
