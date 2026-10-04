import { KnowledgeWorkError, KNOWLEDGE_WORK_ERRORS, parseKnowledgeWorkCommand, parseKnowledgeWorkQuery, knowledgeWorkError } from './core.ts';
import { planKnowledgeCommand, queryKnowledgeState, knowledgeDetail, type KnowledgeState } from './engine.ts';
interface Environment { get(name: string): string | undefined }
declare const Deno: { env: Environment; serve(handler: (request: Request) => Promise<Response>): void };
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
/** Used only after GoTrue verifies this exact token. No body identity is accepted. */
function slackIdentity(token: string, authId: string) {
  try {
    const parts = token.split('.'); if (parts.length !== 3) throw new Error();
    const encoded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=')), c => c.charCodeAt(0))));
    if (!p || p.sub !== authId) throw new Error();
    const keys = ['livo_slack_binding', 'livo_slack_team', 'livo_slack_user'];
    if (!Object.keys(p).some(k => k.startsWith('livo_slack_'))) return null;
    if (!keys.every(k => typeof p[k] === 'string') || !/^[\w-]{1,200}$/.test(p.livo_slack_binding) || !/^T[A-Z0-9]+$/.test(p.livo_slack_team) || !/^[UW][A-Z0-9]+$/.test(p.livo_slack_user)) throw new Error();
    return { bindingId: p.livo_slack_binding, teamId: p.livo_slack_team, userId: p.livo_slack_user };
  } catch { throw new KnowledgeWorkError('knowledge_unauthorized', 401); }
}
export function knowledgeWorkHandler(env: Environment, fetcher: typeof fetch = fetch) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'knowledge_invalid_input' }, 405);
    try {
      if (Number(request.headers.get('content-length') || 0) > 524288) throw new KnowledgeWorkError('knowledge_invalid_input', 413);
      const raw = await request.text(); if (new TextEncoder().encode(raw).byteLength > 524288) throw new KnowledgeWorkError('knowledge_invalid_input', 413);
      const input = JSON.parse(raw);
      if (!input || typeof input !== 'object' || !['query', 'command'].includes(input.type) || Object.keys(input).some(k => !['type', input.type].includes(k))) throw new KnowledgeWorkError('knowledge_invalid_input');
      const command = input.type === 'command' ? parseKnowledgeWorkCommand(input.command) : null;
      const query = command ? null : parseKnowledgeWorkQuery(input.query);
      const base = env.get('SUPABASE_URL')?.replace(/\/$/, ''), anon = env.get('SUPABASE_ANON_KEY'), service = env.get('SUPABASE_SERVICE_ROLE_KEY');
      const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1];
      if (!base || !anon || !service) throw new KnowledgeWorkError('knowledge_unavailable', 503);
      if (!token || token === anon || token === service) throw new KnowledgeWorkError('knowledge_unauthorized', 401);
      const auth = await fetcher(`${base}/auth/v1/user`, { headers: { apikey: anon, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) });
      if (!auth.ok) throw new KnowledgeWorkError('knowledge_unauthorized', 401);
      const user = await auth.json(); if (typeof user.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user.id)) throw new KnowledgeWorkError('knowledge_unauthorized', 401);
      const identity = slackIdentity(token, user.id);
      const rpc = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
        const response = await fetcher(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: anon, Authorization: `Bearer ${service}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ p_auth_id: user.id, p_slack_identity: identity, ...body }), signal: AbortSignal.timeout(25000) });
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          const code = typeof data?.message === 'string' && Object.prototype.hasOwnProperty.call(KNOWLEDGE_WORK_ERRORS, data.message) ? data.message
            : ['40001', 'PT409', '40P01'].includes(data?.code) ? 'knowledge_conflict' : 'knowledge_unavailable';
          throw new KnowledgeWorkError(code, KNOWLEDGE_WORK_ERRORS[code] || 503);
        }
        return data as T;
      };
      const snapshot = () => rpc<KnowledgeState>('livo_knowledge_work_snapshot', { p_command_id: command?.commandId || (query?.operation==='command_result'?query.commandId:null) });
      const state = await snapshot();
      if (query) return json(await queryKnowledgeState(state, query));
      const plan = await planKnowledgeCommand(state, command, () => crypto.randomUUID());
      if (plan.result.replayed) return json(plan.result);
      try { await rpc('livo_knowledge_work_commit', { p_plan: plan }); }
      catch (error) {
        // A concurrent identical request may already have committed. Read the
        // receipt through live authorization; never return a cached private body.
        const fresh = await snapshot(), replay = await planKnowledgeCommand(fresh, command, () => crypto.randomUUID());
        if (replay.result.replayed) return json(replay.result);
        throw error;
      }
      const fresh = await snapshot();
      return json({ ...plan.result, page: await knowledgeDetail(fresh, plan.pageId) });
    } catch (error) {
      const e = error instanceof SyntaxError ? new KnowledgeWorkError('knowledge_invalid_input') : knowledgeWorkError(error);
      return json({ error: e.code }, e.status);
    }
  };
}
if (typeof Deno !== 'undefined') Deno.serve(knowledgeWorkHandler(Deno.env));
