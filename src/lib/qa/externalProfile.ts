import { fnUrl } from '@/lib/apiBase';
import { supabase } from '@/integrations/supabase/client';
import type { Project, User } from '@/types';

export interface ExternalQaProfile {
  external: true;
  id: string;
  name: string;
  qaEnabled: boolean;
  environments: string[];
  projects: Project[];
  members: User[];
}

type WorkspaceProfile = ExternalQaProfile | { external: false };
export class QaProfilePasswordChangeRequired extends Error {
  constructor() { super('qa_password_change_required'); }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid-qa-profile');
  return value as Record<string, unknown>;
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('invalid-qa-profile');
  return value;
}

function optionalText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function parseWorkspaceProfile(value: unknown): WorkspaceProfile {
  const profile = record(value);
  if (profile.external === false) return { external: false };
  if (profile.external !== true || typeof profile.qaEnabled !== 'boolean' ||
    !Array.isArray(profile.projects) || !Array.isArray(profile.environments) || !Array.isArray(profile.members)) {
    throw new Error('invalid-qa-profile');
  }
  const projects = profile.projects.map(value => {
    const project = record(value);
    return { id: requiredText(project.id), name: requiredText(project.name), lineId: optionalText(project.lineId),
      color: optionalText(project.color), key: optionalText(project.key), isArchived: project.isArchived === true };
  });
  const members: User[] = profile.members.map((value, sortOrder) => {
    const member = record(value);
    return { id: requiredText(member.id), name: requiredText(member.name), avatar: optionalText(member.avatar),
      color: optionalText(member.color), jobTitle: optionalText(member.jobTitle), isActive: member.isActive === true,
      role: 'member', email: '', sortOrder };
  });
  return { external: true, id: requiredText(profile.id), name: requiredText(profile.name), qaEnabled: profile.qaEnabled,
    environments: profile.environments.map(requiredText), projects, members };
}

export async function readWorkspaceProfile(signal: AbortSignal): Promise<WorkspaceProfile> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.access_token) throw new Error('qa-profile-unauthorized');
  const request = new AbortController();
  const cancel = () => request.abort();
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  const timeout = setTimeout(cancel, 15_000);
  try {
    const response = await fetch(fnUrl('qa'), {
      method: 'POST', cache: 'no-store', signal: request.signal,
      headers: {
        Authorization: 'Bearer ' + session.access_token,
        'Content-Type': 'application/json',
        ...(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ? { apikey: String(import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY) } : {}),
      },
      body: JSON.stringify({ action: 'external_profile' }),
    });
    if (!response.ok) {
      const error = await response.json().catch((): null => null);
      if (response.status === 403 && error?.error === 'qa_password_change_required') throw new QaProfilePasswordChangeRequired();
      throw new Error('qa-profile-unavailable');
    }
    return parseWorkspaceProfile(await response.json());
    } finally {
    clearTimeout(timeout);
    signal.removeEventListener('abort', cancel);
  }
}
