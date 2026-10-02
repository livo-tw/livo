import { useEffect, useState } from 'react';
import type { QaClient } from '@/lib/qa/client';

export interface QaVersionsState { values: string[]; status: 'loading' | 'ready' | 'failed'; }

/** One request per form/project, shared by all of that form's version inputs. */
export function useQaVersions(client: Pick<QaClient, 'versions'>, projectId: string): QaVersionsState {
  const [state, setState] = useState<QaVersionsState & { projectId: string }>({ projectId: '', values: [], status: 'ready' });
  useEffect(() => {
    const controller = new AbortController();
    if (!projectId) { setState({ projectId, values: [], status: 'ready' }); return () => controller.abort(); }
    setState({ projectId, values: [], status: 'loading' });
    void Promise.resolve().then(() => client.versions(projectId, controller.signal)).then(values => {
      if (!controller.signal.aborted) setState({ projectId, values, status: 'ready' });
    }).catch(() => {
      if (!controller.signal.aborted) setState({ projectId, values: [], status: 'failed' });
    });
    return () => controller.abort();
  }, [client, projectId]);
  // A switched project must not display old options even before effect cleanup.
  return state.projectId === projectId ? state : { values: [], status: projectId ? 'loading' : 'ready' };
}
