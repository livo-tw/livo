import { useEffect, useState } from 'react';
import { useExternalQa } from '@/context/ExternalQaContext';
import { USE_CF_BACKEND } from '@/lib/apiBase';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import type { QaClient, QaFilterPerson } from '@/lib/qa/client';

/** Complete, read-only filter labels. Never used as assignment eligibility. */
export function useQaFilterPeople(client: Partial<Pick<QaClient, 'filterPeople'>>, projectIds: string[], actorId: string) {
  const externalQa = useExternalQa();
  const load = client.filterPeople;
  const enabled = !externalQa && !USE_CF_BACKEND && USING_MOCK_BACKEND === false && !!load;
  const projectKey = JSON.stringify([...new Set(projectIds)].sort());
  const scope = `${actorId}:${projectKey}`;
  const [revision, setRevision] = useState(0);
  const [snapshot, setSnapshot] = useState<{ scope: string; people?: QaFilterPerson[]; failed?: boolean }>();
  useEffect(() => {
    if (!enabled || !load) return;
    const request = new AbortController();
    setSnapshot({ scope });
    const read = async () => {
      const people = new Map<string, QaFilterPerson>();
      for (let offset = 0; ; offset += 100) {
        const page = await load({ projectIds: JSON.parse(projectKey), offset }, request.signal);
        if (request.signal.aborted) return;
        if (!Array.isArray(page.members) || page.members.length > 100 || typeof page.hasMore !== 'boolean') throw new Error('invalid-qa-filter-people');
        const count = people.size;
        for (const person of page.members) {
          if (typeof person.id !== 'string' || !person.id || typeof person.name !== 'string' || !person.name.trim() || typeof person.isActive !== 'boolean') throw new Error('invalid-qa-filter-people');
          people.set(person.id, person);
        }
        if (!page.hasMore) break;
        if (people.size === count || offset >= 100000) throw new Error('incomplete-qa-filter-people');
      }
      setSnapshot({ scope, people: [...people.values()] });
    };
    void read().catch(() => { if (!request.signal.aborted) setSnapshot({ scope, failed: true }); });
    return () => request.abort();
  }, [enabled, load, projectKey, scope, revision]);
  const current = snapshot?.scope === scope ? snapshot : undefined;
  return {
    people: enabled ? current?.people : undefined,
    loading: enabled && !current?.people && !current?.failed,
    failed: enabled && current?.failed === true,
    retry: () => setRevision(value => value + 1),
  };
}
