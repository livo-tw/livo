import { createKnowledgeWorkflowService } from './service.ts';
import { KnowledgeWorkflowError } from './domain.ts';
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async request => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({error:{code:'kb_workflow_invalid'}},405);
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 262144) throw new KnowledgeWorkflowError('kb_workflow_too_large',413);
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '';
    return json(await createKnowledgeWorkflowService(Deno.env,token).handle(JSON.parse(raw)));
  } catch (error) {
    return json({error:{code:error instanceof KnowledgeWorkflowError ? error.code : 'kb_workflow_invalid'}},error instanceof KnowledgeWorkflowError ? error.status : 400);
  }
});
