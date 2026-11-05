import { genericTaskOg } from './handler.ts';

// Public crawlers have no card ACL. Rich previews use the verified Slack event
// adapter; a User-Agent (including Slackbot) must never grant a service-role read.
Deno.serve((req: Request) => genericTaskOg(req, Deno.env.get('APP_BASE_URL') || 'https://livo-tw.com'));
