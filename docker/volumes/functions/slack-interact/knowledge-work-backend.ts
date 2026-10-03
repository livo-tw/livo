import type { Row } from './core.ts';
import { KnowledgeWorkError, KNOWLEDGE_WORK_ERRORS, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery } from './knowledge-work-core.ts';
export interface KnowledgeWorkData { request(actor: Row, type: 'query' | 'command', value: unknown): Promise<Row>; link(pageId: string): string }
export function createKnowledgeWorkData(env: { get(name: string): string | undefined }, fetcher: typeof fetch = fetch): KnowledgeWorkData {
  return {
    link: id => `${(env.get('APP_BASE_URL') || '').replace(/\/$/, '')}/?knowledge=${encodeURIComponent(id)}`,
    async request(actor, type, value) {
      if (!actor.jwt || !actor.binding_id || !actor.team || !actor.slack_user) throw new KnowledgeWorkError('knowledge_forbidden', 403);
      const parsed = type === 'command' ? parseKnowledgeWorkCommand(value) : parseKnowledgeWorkQuery(value);
      try {
        const response = await fetcher(`${env.get('SUPABASE_URL')?.replace(/\/$/, '')}/functions/v1/knowledge-work`, { method:'POST',
          headers:{apikey:env.get('SUPABASE_ANON_KEY') || '',Authorization:`Bearer ${actor.jwt}`,'Content-Type':'application/json'},
          body:JSON.stringify({type,[type]:parsed}),signal:AbortSignal.timeout(25000) });
        const body = await response.json().catch((): null => null);
        if (!response.ok || body?.error) {
          const code = typeof body?.error === 'string' && Object.prototype.hasOwnProperty.call(KNOWLEDGE_WORK_ERRORS,body.error) ? body.error : 'knowledge_transport_error';
          throw new KnowledgeWorkError(code, KNOWLEDGE_WORK_ERRORS[code]);
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new KnowledgeWorkError('knowledge_transport_error',503);
        return body;
      } catch(error) { if(error instanceof KnowledgeWorkError) throw error; throw new KnowledgeWorkError('knowledge_transport_error',503); }
    },
  };
}
