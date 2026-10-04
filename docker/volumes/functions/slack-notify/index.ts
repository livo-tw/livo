// slack-notify — post task-event and report notifications to Slack.
//
// SELF-HOST version: calls the Slack Web API DIRECTLY (Bearer bot token from the
// server-only slack_config table, or SLACK_BOT_TOKEN). Self-contained within the
// docker/volumes/functions tree; mirrors worker/src/functions/slack.ts. The
// handler lives in ./service.ts and the shared message rules in ./core.ts.
import { handleSlackNotify } from './service.ts';

Deno.serve(req => handleSlackNotify(req, Deno.env));
