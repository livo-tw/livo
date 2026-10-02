import { constantTimeSecret, createActions } from './backend.ts';
import { handleInteraction } from './handler.ts';
import { createQaSlackActions } from '../qa/slackAdapter.ts';
import { drainQaSlackInbox } from '../qa/slack.ts';

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
    actions.qa = createQaSlackActions(Deno.env, actions);
    if (envelope.payload.type === 'heartbeat') EdgeRuntime.waitUntil(drainQaSlackInbox(actions.qa).catch(() => console.error('qa_slack_retry_unavailable')));
    const result = await handleInteraction(envelope.payload, envelope.envelope_id, actions);
    return Response.json(result);
  } catch { return Response.json({ error: 'interaction_failed' }, { status: 500 }); }
});
