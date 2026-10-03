import type { AuthCtx, Ctx, Env } from './env';
import { appBaseUrl } from './env';
import { knowledgePermissionSql } from './knowledgeSql';
import { createCloudQaSlackActions } from './qaSlack';
import { qaSlackClient } from './qaSlackSync';
import { KNOWLEDGE_SEARCH_SIZE, normalizeKnowledgeSearch, type KnowledgeSearchQuery,
  type KnowledgeSlackActions } from './knowledgeSlackCore';

export async function searchCloudKnowledge(env: Env, auth: AuthCtx, input: KnowledgeSearchQuery) {
  const query = normalizeKnowledgeSearch(input), ws = auth.member.workspaceId || 'default';
  const permission = knowledgePermissionSql('p.id', 'view', auth);
  const results = await env.DB.prepare(`SELECT p.id,p.title,p.category,p.project_id,p.updated_at,p.version,pr.name AS project_name
    FROM kb_pages p LEFT JOIN projects pr ON pr.id=p.project_id AND pr.workspace_id=p.workspace_id
    WHERE p.workspace_id=? AND p.is_archived=0
      AND (instr(lower(p.title),lower(?))>0 OR instr(lower(p.body),lower(?))>0)
      AND (?='all' OR p.category=?) AND ${permission.sql}
    ORDER BY CASE WHEN instr(lower(p.title),lower(?))>0 THEN 0 ELSE 1 END,p.updated_at DESC,p.id
    LIMIT ? OFFSET ?`).bind(ws, query.text, query.text, query.category, query.category,
      ...permission.params, query.text, KNOWLEDGE_SEARCH_SIZE + 1, query.page * KNOWLEDGE_SEARCH_SIZE)
    .all<Record<string, unknown>>();
  return { pages: results.results.slice(0, KNOWLEDGE_SEARCH_SIZE), hasMore: results.results.length > KNOWLEDGE_SEARCH_SIZE, page: query.page };
}
export function createCloudKnowledgeSlackActions(env: Env, ws: string, ctx: Ctx): KnowledgeSlackActions {
  // Reuse the live Slack-email/auth verification, not legacy editable bindings.
  const identity = createCloudQaSlackActions(env, ws, ctx);
  return {
    enabled: async () => {
      const row = await env.DB.prepare("SELECT value FROM system_settings WHERE workspace_id=? AND key='feature_toggles'")
        .bind(ws).first<{ value: string }>();
      try { return JSON.parse(row?.value || '{}').slackActions === true; } catch { return false; }
    },
    actor: identity.actor,
    search: (actor, query) => searchCloudKnowledge(env, actor.auth as AuthCtx, query),
    link: page => `${appBaseUrl(env).replace(/\/$/, '')}/demo/?kb=${encodeURIComponent(String(page.id))}`,
    slack: qaSlackClient(env, ws),
    background: work => ctx.waitUntil(work),
  };
}
