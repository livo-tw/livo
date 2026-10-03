/** Wire contract and pure ACL evaluator. Empty custom rules deny; admins do not bypass view. */
export type KnowledgeAction = 'view' | 'edit' | 'comment';
export type KnowledgeRule = { roles: string[]; positions: string[]; member_ids: string[] };
export type KnowledgePolicy = { mode: 'inherit' } | { mode: 'custom'; view: KnowledgeRule; edit: KnowledgeRule; comment: KnowledgeRule };
export type KnowledgeActor = { id: string; role: string; job_title?: string; jobTitle?: string; is_active?: boolean | number };
export type KnowledgeAclPage = { id: string; parent_id: string | null; access_policy?: unknown; private_draft_owner_id?: string | null; admin_only?: boolean | number; is_archived?: boolean | number };
export const DEFAULT_KNOWLEDGE_POLICY: KnowledgePolicy = { mode: 'inherit' };
export const knowledgeIsAdmin = (role: string) => role === 'admin' || role === 'super_admin';

export function parseKnowledgePolicy(raw: unknown): KnowledgePolicy | null {
  if (raw === undefined) return DEFAULT_KNOWLEDGE_POLICY;
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return null; } }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  if (p.mode === 'inherit' && Object.keys(p).every(k => k === 'mode')) return { mode: 'inherit' };
  if (p.mode !== 'custom' || Object.keys(p).some(k => !['mode', 'view', 'edit', 'comment'].includes(k))) return null;
  for (const action of ['view', 'edit', 'comment']) {
    const r = p[action] as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some(k => !['roles', 'positions', 'member_ids'].includes(k))) return null;
    for (const key of ['roles', 'positions', 'member_ids']) {
      const a = r[key];
      if (!Array.isArray(a) || a.length > 200 || a.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) return null;
    }
    if ((r.roles as string[]).some(v => !['member', 'admin', 'super_admin'].includes(v))) return null;
  }
  return p as KnowledgePolicy;
}

export function knowledgeRuleMatches(rule: KnowledgeRule, actor: KnowledgeActor): boolean {
  return rule.roles.includes(actor.role) || rule.member_ids.includes(actor.id)
    || rule.positions.includes(actor.job_title ?? actor.jobTitle ?? '');
}

export function knowledgeCan(pages: KnowledgeAclPage[], pageId: string, actor: KnowledgeActor | null | undefined, action: KnowledgeAction): boolean {
  if (!actor?.id || !['member', 'admin', 'super_admin'].includes(actor.role) || actor.is_active === false || actor.is_active === 0) return false;
  const byId = new Map(pages.map(p => [p.id, p]));
  let page = byId.get(pageId);
  if (!page) return false;
  const seen = new Set<string>();
  while (page) {
    if (seen.has(page.id) || seen.size >= 3) return false;
    seen.add(page.id);
    if (page.private_draft_owner_id && page.private_draft_owner_id !== actor.id) return false;
    const policy = parseKnowledgePolicy(page.access_policy);
    if (!policy) return false;
    if (policy.mode === 'custom' && (!knowledgeRuleMatches(policy.view, actor) || (action !== 'view' && !knowledgeRuleMatches(policy[action], actor)))) return false;
    if (action !== 'view' && (page.is_archived || (action === 'edit' && page.admin_only && !knowledgeIsAdmin(actor.role)))) return false;
    if (!page.parent_id) return true;
    page = byId.get(page.parent_id);
    if (!page) return false;
  }
  return false;
}
