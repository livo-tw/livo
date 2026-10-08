import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { createInvitationBackend } from './backend.ts';
import { createInvitationHandler } from './handler.ts';

const env = {
  url: Deno.env.get('SUPABASE_URL') || '',
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '',
  anonKey: Deno.env.get('SUPABASE_ANON_KEY') || '',
  appBaseUrl: Deno.env.get('APP_BASE_URL') || '',
};
const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
Deno.serve(createInvitationHandler(createInvitationBackend(admin, env)));
