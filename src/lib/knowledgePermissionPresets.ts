import type { KnowledgePolicy, KnowledgeRule } from '@/types/knowledge';

export type KnowledgePreset = 'self' | 'workspace' | 'inherit' | 'custom';
const member = (id: string): KnowledgeRule => ({ roles: [], positions: [], member_ids: id ? [id] : [] });
const everyone = (): KnowledgeRule => ({ roles: ['member', 'admin', 'super_admin'], positions: [], member_ids: [] });

export function knowledgePermissionPreset(preset: 'self' | 'workspace', memberId: string): KnowledgePolicy {
  return preset === 'self'
    ? { mode: 'custom', view: member(memberId), edit: member(memberId), comment: member(memberId) }
    : { mode: 'custom', view: everyone(), edit: member(memberId), comment: everyone() };
}

export function identifyKnowledgePreset(policy: KnowledgePolicy, memberId: string): KnowledgePreset {
  if (policy.mode === 'inherit') return 'inherit';
  const normalized = (value: KnowledgePolicy) => JSON.stringify(value.mode === 'inherit' ? value : {
    mode: value.mode, ...Object.fromEntries((['view', 'edit', 'comment'] as const).map(action => [action, { roles: [...value[action].roles].sort(), positions: [...value[action].positions].sort(), member_ids: [...value[action].member_ids].sort() }]))
  });
  for (const preset of ['self', 'workspace'] as const) if (normalized(policy) === normalized(knowledgePermissionPreset(preset, memberId))) return preset;
  return 'custom';
}
