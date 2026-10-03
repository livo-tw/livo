import { constantTimeSecret } from '../slack-interact/backend.ts';
import { drainDeliveries } from './backend.ts';
import { drainReleaseDeliveries } from './release-backend.ts';

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response(null, { status: 405 });
  if (!(await constantTimeSecret(req.headers.get('x-livo-slack-secret') || '', Deno.env.get('SLACK_INTERNAL_SECRET') || '')))
    return new Response(null, { status: 401 });
  try {
    const [tasks, releases] = await Promise.all([drainDeliveries(Deno.env), drainReleaseDeliveries(Deno.env)]);
    return Response.json({ ...tasks, releases });
  }
  catch { return Response.json({ error: 'slack_delivery_unavailable' }, { status: 503 }); }
});
