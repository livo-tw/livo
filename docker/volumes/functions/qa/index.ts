import { createQaService } from './service.ts';
import { QaError } from './domain.ts';
import { QaFieldError } from './fields.ts';

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return json({ error: { code: 'qa_method_not_allowed', message: 'POST required' } }, 405);
  try {
    const declared = Number(request.headers.get('content-length') || 0);
    if (declared > 20 * 1024 * 1024) throw new QaError('qa_request_too_large', 413);
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 20 * 1024 * 1024) throw new QaError('qa_request_too_large', 413);
    const token = request.headers.get('authorization')?.match(/^Bearer (.+)$/i)?.[1] || '';
    const result = await createQaService(Deno.env, token).handle(JSON.parse(raw));
    if (result instanceof Response) { for (const [key, value] of Object.entries(cors)) result.headers.set(key, value); return result; }
    return json(result);
  } catch (error) {
    const code = error instanceof QaError || error instanceof QaFieldError ? error.code : error instanceof SyntaxError ? 'qa_invalid_json' : 'qa_internal_error';
    return json({ error: { code, message: code } }, error instanceof QaError ? error.status : error instanceof SyntaxError || error instanceof QaFieldError ? 400 : 500);
  }
});
