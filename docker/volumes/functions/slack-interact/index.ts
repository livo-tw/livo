import { constantTimeSecret, createActions } from './backend.ts';
import { handleInteraction } from './handler.ts';

Deno.serve(async req => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  if (!(await constantTimeSecret(req.headers.get('x-livo-slack-secret') || '', Deno.env.get('SLACK_INTERNAL_SECRET') || '')))
    return new Response(null, { status: 401 });
  try {
    const body = await req.text();
    if (body.length > 100000) return new Response(null, { status: 413 });
    const envelope = JSON.parse(body);
    if (!envelope.payload || typeof envelope.envelope_id !== 'string') return new Response(null, { status: 400 });
    const actions = createActions(Deno.env, work => EdgeRuntime.waitUntil(work));
    const result = await handleInteraction(envelope.payload, envelope.envelope_id, actions);
    return Response.json(result);
  } catch { return Response.json({ error: 'interaction_failed' }, { status: 500 }); }
});
