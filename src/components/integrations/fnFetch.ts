// Authenticated raw fetch to a backend function (/api/functions/:name).
// Same helper style as SlackCard's authFetch — extracted so the newer
// integration cards (Email/Webhooks/API tokens) can share it without
// touching SlackCard. Works for both CF + legacy backends via fnUrl().

import { supabase } from '@/integrations/supabase/client';
import { fnUrl } from '@/lib/apiBase';

export async function authFetch(fnName: string, init?: RequestInit): Promise<Response> {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token ?? '';
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined) };
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(fnUrl(fnName), { ...init, headers });
}

/** POST JSON to a backend function and parse the JSON body (never throws on bad JSON). */
export async function authPostJson<T>(fnName: string, body: unknown): Promise<{ resp: Response; body: T }> {
  const resp = await authFetch(fnName, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await resp.json().catch(() => ({}))) as T;
  return { resp, body: parsed };
}

/** GET a backend function and parse the JSON body (never throws on bad JSON). */
export async function authGetJson<T>(fnName: string): Promise<{ resp: Response; body: T }> {
  const resp = await authFetch(fnName, { method: 'GET' });
  const parsed = (await resp.json().catch(() => ({}))) as T;
  return { resp, body: parsed };
}
