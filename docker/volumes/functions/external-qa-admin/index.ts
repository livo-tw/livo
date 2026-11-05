import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';
import { createExternalQaAdminHandler } from './handler.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
Deno.serve(createExternalQaAdminHandler(admin));
