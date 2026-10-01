// Backend client selector.
// Priority:
//   1. ?demo=pro sales demo → in-memory mock (never touches any backend)
//   2. VITE_API_URL set     → Cloudflare Worker backend (current)
//   3. VITE_SUPABASE_URL    → legacy Supabase (kept for rollback; removed after cutover)
//   4. nothing configured   → in-memory mock (pure offline dev)
// VITE_LOCAL_MODE controls auth/license behavior, NOT which client is used.

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { createMockClient } from './mockClient';
import { createCfClient } from '../backend/cfClient';
import { IS_DEMO_PRO } from '@/lib/demoMode';
import { SUPABASE_URL } from '@/lib/gatewayUrl';
import type { Database } from './types';

const API_URL = import.meta.env.VITE_API_URL || '';

function selectClient(): unknown {
  if (IS_DEMO_PRO || (!API_URL && !SUPABASE_URL)) return createMockClient();
  if (API_URL) return createCfClient();
  // SUPABASE_URL, not the raw env value: on a self-host install opened from
  // another machine it points at the server instead of the visitor's localhost.
  return createClient<Database>(
    SUPABASE_URL,
    import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
    {
      auth: {
        storage: localStorage,
        persistSession: true,
        autoRefreshToken: true,
      },
      realtime: {
        params: {
          eventsPerSecond: 10,
        },
        heartbeatIntervalMs: 15000,
        reconnectAfterMs: (tries: number) =>
          [500, 1000, 2000, 5000, 10000][Math.min(tries, 4)],
      },
    }
  );
}

export const supabase = selectClient() as SupabaseClient<Database>;
