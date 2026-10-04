import { KnowledgeWorkflowError, workflowFail, workflowRecord } from './domain.ts';
export interface KnowledgeWorkflowEnvironment { get(name: string): string | undefined }

/** Forward only the verified caller's JWT. RLS/transaction actor is never supplied by the client. */
export function createKnowledgeWorkflowService(env: KnowledgeWorkflowEnvironment, token: string) {
  return { async handle(input: unknown): Promise<unknown> {
    workflowRecord(input);
    if (!token || token === env.get('SUPABASE_SERVICE_ROLE_KEY') || token === env.get('SUPABASE_ANON_KEY')) workflowFail('kb_workflow_unauthorized', 401);
    const response = await fetch(`${env.get('SUPABASE_URL')}/rest/v1/rpc/kb_workflow`, { method: 'POST',
      headers: { apikey: env.get('SUPABASE_ANON_KEY') || '', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ p_request: input }), signal: AbortSignal.timeout(20000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = String(result.message || '').match(/(?:kb_workflow|qa)_[a-z_]+/)?.[0] || (response.status === 401 ? 'kb_workflow_unauthorized' : 'kb_workflow_invalid');
      throw new KnowledgeWorkflowError(code, result.code === '42501' ? 403 : result.code === 'P0002' ? 404
        : ['40001','PT409','23505'].includes(result.code) ? 409 : response.status >= 500 ? 503 : 400);
    }
    return result;
  } };
}
