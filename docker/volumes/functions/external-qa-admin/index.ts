import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.98.0';

const admin = createClient(Deno.env.get('SUPABASE_URL') || '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const deny = (error: string, status: number) => respond({ error }, status);

function databaseError(error: { code?: string; message?: string }) {
  if (error.code === '42501') return deny('external_qa_forbidden', 403);
  if (error.code === 'PT409' || error.code === '23505') {
    return deny(error.message === 'external_qa_email_in_use' ? 'external_qa_email_in_use' : 'external_qa_stale', 409);
  }
  if (error.code === '22023') {
    return deny(error.message === 'external_qa_invalid_projects' ? 'external_qa_invalid_projects' : 'external_qa_invalid', 400);
  }
  return deny('external_qa_request_failed', 500);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return deny('external_qa_invalid', 405);
  const jwt = req.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
  if (!jwt) return deny('external_qa_forbidden', 401);
  const { data: { user: callerAuth }, error: authError } = await admin.auth.getUser(jwt);
  if (authError || !callerAuth) return deny('external_qa_forbidden', 401);
  const input = await req.json().catch(() => null);
  if (!input || typeof input !== 'object') return deny('external_qa_invalid', 400);
  const scope = { p_admin_auth: callerAuth.id };
  if (input.action === 'list') {
    const { data, error } = await admin.rpc('livo_external_qa_admin', { ...scope, p_action: 'list' });
    return error ? databaseError(error) : respond({ accounts: data });
  }
  if (!['create', 'update'].includes(input.action) || typeof input.name !== 'string' || input.name.length > 200
    || typeof input.isActive !== 'boolean' || !Array.isArray(input.projectIds) || input.projectIds.length > 500
    || input.projectIds.some((id: unknown) => typeof id !== 'string' || id.length > 200)) {
    return deny('external_qa_invalid', 400);
  }
  const fields = { ...scope, p_name: input.name, p_active: input.isActive, p_project_ids: input.projectIds };
  if (input.action === 'update') {
    if (typeof input.id !== 'string' || !/^eqa-[A-Za-z0-9_-]{4,96}$/.test(input.id)
      || !Number.isSafeInteger(input.revision) || input.revision < 1 || input.revision > 2147483647) {
      return deny('external_qa_invalid', 400);
    }
    const { data, error } = await admin.rpc('livo_external_qa_admin', {
      ...fields, p_action: 'update', p_account_id: input.id, p_revision: input.revision,
    });
    return error ? databaseError(error) : respond({ account: data });
  }
  if (typeof input.email !== 'string' || input.email.length > 254) return deny('external_qa_invalid', 400);
  const email = input.email.trim().toLowerCase();
  const { error: preflightError } = await admin.rpc('livo_external_qa_admin', {
    ...fields, p_action: 'prepare', p_email: email,
  });
  if (preflightError) return databaseError(preflightError);

  // GoTrue must create a fresh login; never reuse or reset an existing login.
  const temporaryPassword = crypto.randomUUID().replaceAll('-', '') + '!Aa1';
  const { data: { user }, error: createError } = await admin.auth.admin.createUser({
    email, password: temporaryPassword, email_confirm: true,
    app_metadata: { livo_external_qa: true },
    user_metadata: { livo_password_change_required: true },
  });
  if (createError || !user) {
    return createError?.status === 409 || createError?.code === 'email_exists'
      ? deny('external_qa_email_in_use', 409) : deny('external_qa_request_failed', 500);
  }
  const accountId = 'eqa-' + crypto.randomUUID();
  const { data, error } = await admin.rpc('livo_external_qa_admin', {
    ...fields, p_action: 'create', p_auth_id: user.id, p_account_id: accountId, p_email: email,
  });
  // An uncertain commit may have succeeded. Keep the login and withhold the credential.
  // A fresh admin read distinguishes a saved scope from an unlinked login.
  if (error) return deny('external_qa_registration_pending', 409);
  return respond({ account: data, temporaryPassword }, 201);
});
