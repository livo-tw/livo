import { handleSlackActionsConfig } from './handler.ts';

Deno.serve(req => handleSlackActionsConfig(req, Deno.env));
