// POST JSON to a backend function and keep the response body for success AND
// error statuses. supabase.functions.invoke drops the body of a non-2xx reply
// on the self-hosted backend, but those bodies carry the error code and the
// details the UI needs (missing CSV columns, duplicate emails, …).
// Works for both backends (fnUrl picks the route); the in-memory demo client
// has no backend, so calls report `demo_blocked` without a request.

import { supabase } from '@/integrations/supabase/client';
import { fnUrl, USE_CF_BACKEND } from './apiBase';
import { IS_DEMO_PRO } from './demoMode';

const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || '';

export const DEMO_BLOCKED = 'demo_blocked';

export interface FunctionResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export async function callFunction<T = Record<string, unknown>>(name: string, body: unknown): Promise<FunctionResult<T>> {
  if (IS_DEMO_PRO || (!USE_CF_BACKEND && !SUPABASE_URL)) {
    return { ok: false, status: 0, data: { error: DEMO_BLOCKED } as T };
  }
  const { data: { session } } = await supabase.auth.getSession();
  const resp = await fetch(fnUrl(name), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${session?.access_token || import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY}`,
    },
    body: JSON.stringify(body),
  });
  let data: T | null = null;
  try {
    data = (await resp.json()) as T;
  } catch {
    data = null;
  }
  return { ok: resp.ok, status: resp.status, data };
}
