import type { AuthCtx, Env } from './env';
import { DEFAULT_WORKSPACE } from './env';
import { knowledgePermissionSql } from './knowledgeSql';
import { applyNavigation, emptyNavigation, visibleNavigation, type NavigationCommand, type NavigationPage, type NavigationPreferences } from './knowledgePreferenceModel';

export async function handleKnowledgePreferences(env: Env, auth: AuthCtx, input: unknown) {
  const fail = (message: string) => ({ data: null, error: { message } });
  const command = input as NavigationCommand;
  if (!command || typeof command !== 'object' || Object.keys(command).some(key => !['p_action','p_page_id','p_value','p_before_id','p_order_kind','p_version'].includes(key))) return fail('kb_invalid_request');
  const ws = auth.member.workspaceId || DEFAULT_WORKSPACE, member = auth.member.id;
  const actor = await env.DB.prepare('SELECT id FROM members WHERE workspace_id=? AND id=? AND auth_id=? AND is_active=1').bind(ws, member, auth.userId).first();
  if (!actor) return fail('kb_forbidden');
  const permission = knowledgePermissionSql('kb_pages.id', 'view', auth);
  const loadPages = async () => (await env.DB.prepare(`SELECT id,parent_id,project_id,sort_order,title FROM kb_pages WHERE workspace_id=? AND ${permission.sql}`).bind(ws, ...permission.params).all<NavigationPage>()).results;
  const load = async (): Promise<NavigationPreferences> => {
    const row = await env.DB.prepare('SELECT preferences,version FROM kb_navigation_preferences WHERE workspace_id=? AND member_id=?').bind(ws, member).first<{preferences:string;version:number}>();
    return row ? { ...JSON.parse(row.preferences), version: row.version } : emptyNavigation();
  };
  try {
    const raw = await load();
    if (command.p_action === 'read') return { data: visibleNavigation(raw, await loadPages()), error: null };
    if (!Number.isSafeInteger(command.p_version) || command.p_version !== raw.version) return fail('kb_conflict');
    const next = applyNavigation(raw, await loadPages(), command);
    const page = knowledgePermissionSql('?', 'view', auth);
    // The ID placeholder occurs after the workspace placeholder inside the predicate.
    const pageParams = [page.params[0], command.p_page_id!, ...page.params.slice(1)];
    const target = command.p_before_id ? knowledgePermissionSql('?', 'view', auth) : null;
    const targetParams = target ? [target.params[0], command.p_before_id!, ...target.params.slice(1)] : [];
    const stamp = new Date().toISOString();
    const sql = `INSERT INTO kb_navigation_preferences(workspace_id,member_id,preferences,version,updated_at)
      SELECT ?,?,?,1,? WHERE ?=0 AND ${page.sql}${target ? ` AND ${target.sql}` : ''}
      ON CONFLICT(workspace_id,member_id) DO UPDATE SET preferences=?,version=kb_navigation_preferences.version+1,updated_at=?
      WHERE kb_navigation_preferences.version=? AND ${page.sql}${target ? ` AND ${target.sql}` : ''} RETURNING version`;
    // INSERT SELECT must yield a row for an existing preference too; CAS lives in UPDATE.
    const mutation = sql.replace('WHERE ?=0 AND', 'WHERE (?=0 OR EXISTS (SELECT 1 FROM kb_navigation_preferences WHERE workspace_id=? AND member_id=?)) AND');
    const result = await env.DB.prepare(mutation).bind(ws,member,JSON.stringify(next),stamp,raw.version,ws,member,...pageParams,...targetParams,JSON.stringify(next),stamp,raw.version,...pageParams,...targetParams).first();
    if (!result) return fail('kb_conflict');
    return { data: visibleNavigation(await load(), await loadPages()), error: null };
  } catch (error) { return fail(error instanceof Error && /^kb_/.test(error.message) ? error.message : 'kb_failed'); }
}
