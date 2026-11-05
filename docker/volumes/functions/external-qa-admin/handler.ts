import { isExchangedJwt } from '../api-tokens/core.ts';

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
const deny = (error: string, status: number) => respond({ error }, status);
const uuid = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

function databaseError(error: { code?: string; message?: string }) {
  if (error.code === '42501') return deny('external_qa_forbidden', 403);
  if (error.code === 'PT409' || error.code === '23505') {
    const known = ['external_qa_email_in_use', 'external_qa_already_onboarded', 'external_qa_stale'];
    return deny(known.includes(error.message || '') ? error.message! : 'external_qa_stale', 409);
  }
  if (error.code === '22023') {
    const known = ['external_qa_invalid_projects', 'external_qa_invalid_password'];
    return deny(known.includes(error.message || '') ? error.message! : 'external_qa_invalid', 400);
  }
  return deny('external_qa_request_failed', 500);
}

function initialPassword(input: Record<string, unknown>): string | null {
  const value = input.initialPassword;
  if (value === undefined || value === '') return crypto.randomUUID().replace(/-/g, '') + '!Aa1';
  return typeof value === 'string' && Array.from(value).length >= 8
    && new TextEncoder().encode(value).length <= 72 ? value : null;
}

// The SDK client is injected so request sequencing, unknown commit results and
// credential handling can be exercised without a live GoTrue installation.
export function createExternalQaAdminHandler(admin: any) {
  return async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (req.method !== 'POST') return deny('external_qa_invalid', 405);
    const jwt = req.headers.get('authorization')?.match(/^Bearer (\S+)$/i)?.[1];
    if (!jwt) return deny('external_qa_forbidden', 401);
    let registrationId: string | undefined;
    try {
      const { data: { user: callerAuth }, error: authError } = await admin.auth.getUser(jwt);
      if (authError || !callerAuth) return deny('external_qa_forbidden', 401);
      const input = await req.json().catch((): null => null);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('external_qa_invalid', 400);
      const scope = { p_admin_auth: callerAuth.id };
      if (input.action === 'list') {
        const { data, error } = await admin.rpc('livo_external_qa_registration_list', scope);
        return error ? databaseError(error) : respond({ accounts: data });
      }
      // Check the verified token before any password, identity or grant write.
      if (isExchangedJwt(jwt)) return deny('api_key_forbidden', 403);
      if (!['create', 'update', 'recover'].includes(input.action)) return deny('external_qa_invalid', 400);
      if (input.action !== 'recover' && (typeof input.name !== 'string' || input.name.length > 200
        || typeof input.isActive !== 'boolean' || !Array.isArray(input.projectIds) || input.projectIds.length > 500
        || input.projectIds.some((id: unknown) => typeof id !== 'string' || id.length > 200))) {
        return deny('external_qa_invalid', 400);
      }
      if (input.action !== 'create' && (typeof input.id !== 'string' || !/^eqa-[A-Za-z0-9_-]{4,96}$/.test(input.id)
        || !Number.isSafeInteger(input.revision) || input.revision < (input.action === 'recover' ? 0 : 1)
        || input.revision > 2147483647)) return deny('external_qa_invalid', 400);

      if (input.action === 'update') {
        const { data, error } = await admin.rpc('livo_external_qa_admin', {
          ...scope, p_action: 'update', p_account_id: input.id, p_revision: input.revision,
          p_name: input.name, p_active: input.isActive, p_project_ids: input.projectIds,
        });
        return error ? databaseError(error) : respond({ account: data });
      }
      const password = initialPassword(input);
      if (password === null) return deny('external_qa_invalid_password', 400);
      let prepared: any;
      if (input.action === 'create') {
        if (!uuid(input.requestId) || typeof input.email !== 'string' || input.email.length > 254) {
          return deny('external_qa_invalid', 400);
        }
        const { data, error } = await admin.rpc('livo_external_qa_registration', {
          ...scope, p_action: 'reserve', p_request_id: input.requestId,
          p_name: input.name, p_email: input.email.trim().toLowerCase(),
          p_active: input.isActive, p_project_ids: input.projectIds,
        });
        if (error) return databaseError(error);
        prepared = data;
      } else {
        if (!uuid(input.registrationId)) return deny('external_qa_invalid', 400);
        const { data, error } = await admin.rpc('livo_external_qa_registration', {
          ...scope, p_action: 'prepare_recovery', p_registration_id: input.registrationId,
          p_account_id: input.id, p_revision: input.revision,
        });
        if (error) return databaseError(error);
        prepared = data;
      }
      if (!prepared || !uuid(prepared.registrationId)) return deny('external_qa_request_failed', 500);
      registrationId = prepared.registrationId;
      let createdAuthKnown = false;
      if (prepared.authRequired) {
        const result = await admin.auth.admin.createUser({
          email: prepared.email, password, email_confirm: true,
          app_metadata: {
            livo_external_qa: true,
            livo_external_qa_registration: registrationId,
            livo_external_qa_nonce: prepared.nonce,
            livo_external_qa_password_change_required: true,
          },
          user_metadata: { livo_password_change_required: true },
        });
        createdAuthKnown = !result.error && !!result.data?.user?.id;
        // Even a failed or interrupted GoTrue response can have committed.
        // Only the trusted reservation nonce can reconcile that new login.
      }
      const reconciled = await admin.rpc('livo_external_qa_registration', {
        ...scope, p_action: 'reconcile', p_registration_id: registrationId,
      });
      if (reconciled.error) return databaseError(reconciled.error);
      const account = reconciled.data?.account;
      if (!account) return respond({ error: 'external_qa_registration_pending', registrationId }, 409);
      if (input.action === 'create') {
        if (!createdAuthKnown) return respond({ error: 'external_qa_registration_pending', registrationId }, 409);
        return respond({ account, temporaryPassword: password }, 201);
      }
      const recovered = await admin.rpc('livo_external_qa_registration', {
        ...scope, p_action: 'recover', p_registration_id: registrationId,
        p_account_id: account.id, p_revision: input.revision === 0 ? 1 : input.revision, p_initial_password: password,
      });
      if (recovered.error) return databaseError(recovered.error);
      return respond({ account: recovered.data?.account, temporaryPassword: password });
    } catch {
      return registrationId
        ? respond({ error: 'external_qa_registration_pending', registrationId }, 409)
        : deny('external_qa_request_failed', 500);
    }
  };
}
