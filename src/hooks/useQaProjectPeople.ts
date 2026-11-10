import { useEffect, useMemo, useState } from 'react';
import { useExternalQa } from '@/context/ExternalQaContext';
import { useMemberContext } from '@/context/MemberContext';
import { USE_CF_BACKEND } from '@/lib/apiBase';
import { USING_MOCK_BACKEND } from '@/integrations/supabase/client';
import type { QaClient, QaProjectPerson } from '@/lib/qa/client';
import type { QaAssignmentUser } from '@/lib/qa/assignmentPeople';

const NO_PEOPLE: QaAssignmentUser[] = [];
type PeopleClient = Partial<Pick<QaClient, 'projectPeople'>>;

export function useQaProjectPeople(client: PeopleClient, projectId: string) {
  const externalQa = useExternalQa();
  const { users } = useMemberContext();
  const load = client.projectPeople;
  const enabled = !!projectId && !!load && (externalQa || (USING_MOCK_BACKEND === false && !USE_CF_BACKEND));
  const [snapshot, setSnapshot] = useState<{ projectId: string; members: QaProjectPerson[] } | null>(null);
  useEffect(() => {
    setSnapshot(null);
    if (!enabled || !load) return;
    const request = new AbortController();
    const loadPeople = async () => {
      const members = new Map<string, QaProjectPerson>();
      for (let offset = 0; ; offset += 100) {
        const page = await load(projectId, offset, request.signal);
        if (request.signal.aborted) return;
        const count = members.size;
        for (const member of page.members) members.set(member.id, member);
        if (!page.hasMore) break;
        if (members.size === count) throw new Error('invalid-qa-people-page');
      }
      setSnapshot({ projectId, members: [...members.values()] });
    };
    void loadPeople().catch(() => { /* No partial set is offered as project eligibility. */ });
    return () => request.abort();
  }, [enabled, load, projectId]);

  return useMemo(() => {
    if (!enabled || snapshot?.projectId !== projectId) return externalQa ? NO_PEOPLE : undefined;
    const choices = new Map<string, QaAssignmentUser>(externalQa ? [] : users.map(user => [user.id, user]));
    for (const person of snapshot.members) {
      if (!choices.has(person.id)) choices.set(person.id, {
        id: person.id, name: person.name, avatar: person.avatar ?? '', color: person.color ?? '',
        jobTitle: person.jobTitle ?? '', isActive: person.isActive, email: '', role: 'member', sortOrder: 0,
        qaExternal: person.isExternal !== false, isExternal: person.isExternal,
      });
    }
    return [...choices.values()];
  }, [enabled, externalQa, projectId, snapshot, users]);
}
