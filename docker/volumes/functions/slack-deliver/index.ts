import { constantTimeSecret } from '../slack-interact/backend.ts';
import { drainDeliveries } from './backend.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  if (!(await constantTimeSecret(req.headers.get('x-livo-slack-secret') || '', Deno.env.get('SLACK_INTERNAL_SECRET') || '')))
    return new Response(null, { status: 401 });
  try { return Response.json(await drainDeliveries(Deno.env)); }
  catch { return Response.json({ error: 'slack_delivery_unavailable' }, { status: 503 }); }
});
