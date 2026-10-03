#!/usr/bin/env node
// Keeps the copies of shared backend code byte-identical. The self-hosted edge
// functions are self-contained (no imports across function folders), so code
// they share with each other or with the Cloudflare worker lives in copies.
//
//   node scripts/sync-shared-code.mjs           copy every source over its copies
//   node scripts/sync-shared-code.mjs --check   exit 1 when a copy differs
//
// A copy whose folder does not exist is skipped (the open-source repository
// has no supabase/functions/).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SHARED = [
  { source: 'src/lib/customFieldTypes.ts', copies: ['src/lib/qa/customFieldTypes.ts', 'worker/src/qa/customFieldTypes.ts', 'docker/volumes/functions/qa/customFieldTypes.ts', 'supabase/functions/qa/customFieldTypes.ts'] },
  { source: 'src/lib/qa/fields.ts', copies: ['worker/src/qa/fields.ts', 'docker/volumes/functions/qa/fields.ts', 'supabase/functions/qa/fields.ts'] },
  { source: 'worker/src/knowledgeImport.ts', copies: ['docker/volumes/functions/knowledge-import/knowledgeImport.ts', 'supabase/functions/knowledge-import/knowledgeImport.ts'], denoAccess: true },
  { source: 'worker/src/knowledgeAccess.ts', copies: ['docker/volumes/functions/knowledge-import/knowledgeAccess.ts', 'supabase/functions/knowledge-import/knowledgeAccess.ts'] },
  { source: 'src/lib/knowledgeWorkflowDomain.ts', copies: ['worker/src/knowledgeWorkflow/domain.ts', 'docker/volumes/functions/knowledge-workflow/domain.ts', 'supabase/functions/knowledge-workflow/domain.ts'] },
  { source: 'docker/volumes/functions/knowledge-import/index.ts', copies: ['supabase/functions/knowledge-import/index.ts'] },
  { source: 'docker/volumes/functions/knowledge-workflow/index.ts', copies: ['supabase/functions/knowledge-workflow/index.ts'] },
  { source: 'docker/volumes/functions/knowledge-workflow/service.ts', copies: ['supabase/functions/knowledge-workflow/service.ts'] },
  { source: 'src/lib/knowledgeSlack.ts', copies: ['worker/src/knowledgeSlackCore.ts', 'docker/volumes/functions/slack-interact/knowledge.ts', 'supabase/functions/slack-interact/knowledge.ts'] },
  { source: 'src/lib/deploymentEnvironments.ts', copies: ['src/lib/qa/environments.ts', 'worker/src/qa/environments.ts', 'docker/volumes/functions/qa/environments.ts', 'supabase/functions/qa/environments.ts'] },
  { source: 'src/lib/projectGroups.ts', copies: ['src/lib/qa/projectGroups.ts', 'worker/src/qa/projectGroups.ts', 'docker/volumes/functions/qa/projectGroups.ts', 'supabase/functions/qa/projectGroups.ts', 'docker/volumes/functions/slack-interact/projectGroups.ts', 'supabase/functions/slack-interact/projectGroups.ts'] },
  { source: 'src/lib/qa/workflow.ts', copies: ['worker/src/qa/workflow.ts', 'docker/volumes/functions/qa/workflow.ts', 'supabase/functions/qa/workflow.ts'] },
  { source: 'src/lib/qa/versions.ts', copies: ['worker/src/qa/versions.ts', 'docker/volumes/functions/qa/versions.ts', 'supabase/functions/qa/versions.ts'] },
  { source: 'src/lib/qa/slack.ts', copies: ['worker/src/qa/slack.ts', 'docker/volumes/functions/qa/slack.ts', 'supabase/functions/qa/slack.ts'] },
  ...['index.ts', 'service.ts', 'restore.ts', 'slackAdapter.ts', 'slackSync.ts'].map(file => ({ source: `docker/volumes/functions/qa/${file}`, copies: [`supabase/functions/qa/${file}`] })),
  { source: 'src/lib/qa/domain.ts', copies: ['worker/src/qa/domain.ts', 'docker/volumes/functions/qa/domain.ts', 'supabase/functions/qa/domain.ts'] },
  { source: 'docker/volumes/functions/slack-deliver/core.ts', copies: ['supabase/functions/slack-deliver/core.ts'] },
  { source: 'docker/volumes/functions/slack-deliver/backend.ts', copies: ['supabase/functions/slack-deliver/backend.ts'] },
  { source: 'docker/volumes/functions/slack-deliver/index.ts', copies: ['supabase/functions/slack-deliver/index.ts'] },
  { source: 'docker/volumes/functions/slack-interact/core.ts', copies: ['supabase/functions/slack-interact/core.ts'] },
  { source: 'docker/volumes/functions/slack-interact/handler.ts', copies: ['supabase/functions/slack-interact/handler.ts'] },
  { source: 'docker/volumes/functions/slack-interact/backend.ts', copies: ['supabase/functions/slack-interact/backend.ts'] },
  { source: 'docker/volumes/functions/slack-interact/workspace-ui.ts', copies: ['supabase/functions/slack-interact/workspace-ui.ts'] },
  { source: 'docker/volumes/functions/slack-interact/workspace-i18n.ts', copies: ['supabase/functions/slack-interact/workspace-i18n.ts'] },
  { source: 'docker/volumes/functions/slack-interact/workspace-backend.ts', copies: ['supabase/functions/slack-interact/workspace-backend.ts'] },
  { source: 'docker/volumes/functions/slack-interact/workspace-handler.ts', copies: ['supabase/functions/slack-interact/workspace-handler.ts'] },
  { source: 'docker/volumes/functions/slack-interact/index.ts', copies: ['supabase/functions/slack-interact/index.ts'] },
  { source: 'docker/volumes/functions/slack-actions-config/index.ts', copies: ['supabase/functions/slack-actions-config/index.ts'] },
  { source: 'docker/volumes/functions/slack-notify/index.ts', copies: ['supabase/functions/slack-notify/index.ts'] },
  {
    source: 'worker/src/functions/jiraCsv.ts',
    copies: [
      'docker/volumes/functions/import-jira/jiraCsv.ts',
      'docker/volumes/functions/manage-member/jiraCsv.ts',
      'supabase/functions/import-jira/jiraCsv.ts',
      'supabase/functions/manage-member/jiraCsv.ts',
    ],
  },
  {
    source: 'docker/volumes/functions/manage-member/memberAccounts.ts',
    copies: [
      'docker/volumes/functions/import-jira/memberAccounts.ts',
      'supabase/functions/manage-member/memberAccounts.ts',
      'supabase/functions/import-jira/memberAccounts.ts',
    ],
  },
  // CLAUDE.md: docker/volumes/functions (what customers run) and
  // supabase/functions (dev source) must match.
  { source: 'docker/volumes/functions/import-jira/index.ts', copies: ['supabase/functions/import-jira/index.ts'] },
  { source: 'docker/volumes/functions/manage-member/index.ts', copies: ['supabase/functions/manage-member/index.ts'] },
];

const check = process.argv.includes('--check');
const stale = [];
for (const { source, copies, denoAccess } of SHARED) {
  const original = fs.readFileSync(path.join(ROOT, source));
  const src = denoAccess ? Buffer.from(original.toString('utf8').replace("from './knowledgeAccess'", "from './knowledgeAccess.ts'")) : original;
  for (const copy of copies) {
    const dest = path.join(ROOT, copy);
    if (!fs.existsSync(path.dirname(dest))) continue;
    const same = fs.existsSync(dest) && fs.readFileSync(dest).equals(src);
    if (same) continue;
    if (check) stale.push(`${copy} (from ${source})`);
    else {
      fs.writeFileSync(dest, src);
      console.log(`updated ${copy}`);
    }
  }
}
if (stale.length) {
  console.error(`These copies differ from their source — run \`npm run sync:shared\`:\n  ${stale.join('\n  ')}`);
  process.exit(1);
}
if (check) console.log('shared code copies are in sync');
