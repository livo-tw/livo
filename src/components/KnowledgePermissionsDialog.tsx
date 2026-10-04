import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck, Lock, Users, SlidersHorizontal, CornerDownRight } from 'lucide-react';
import { identifyKnowledgePreset, knowledgePermissionPreset, type KnowledgePreset } from '@/lib/knowledgePermissionPresets';
import type { User } from '@/types';
import type { KnowledgePolicy, KnowledgeRule, KnowledgeAction } from '@/types/knowledge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const emptyRule = (): KnowledgeRule => ({ roles: [], positions: [], member_ids: [] });
const customPolicy = (): KnowledgePolicy => ({ mode: 'custom', view: emptyRule(), edit: emptyRule(), comment: emptyRule() });

export default function KnowledgePermissionsDialog({ open, onOpenChange, policy, users, currentMemberId, hasParent, privateDraft = false, busy, onSave }:
  { open: boolean; onOpenChange: (open: boolean) => void; policy: KnowledgePolicy; users: User[]; hasParent: boolean;
    currentMemberId: string; privateDraft?: boolean; busy: boolean; onSave: (policy: KnowledgePolicy) => Promise<void> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<KnowledgePolicy>(policy);
  const [preset, setPreset] = useState<KnowledgePreset>(() => identifyKnowledgePreset(policy, currentMemberId));
  const [actionTab, setActionTab] = useState<KnowledgeAction>('view');
  const policyKey = JSON.stringify(policy);
  useEffect(() => { if (open) { const next = JSON.parse(policyKey) as KnowledgePolicy; setDraft(next); setPreset(identifyKnowledgePreset(next, currentMemberId)); setActionTab('view'); } }, [open, policyKey, currentMemberId]);
  const activeUsers = users.filter(u => u.isActive !== false);
  const selectedPositions = draft.mode === 'custom' ? (['view', 'edit', 'comment'] as const).flatMap(a => draft[a].positions) : [];
  const positions = [...new Set([...activeUsers.map(u => u.jobTitle).filter(Boolean), ...selectedPositions])].sort();

  function toggle(action: KnowledgeAction, kind: keyof KnowledgeRule, value: string) {
    setDraft(previous => {
      if (previous.mode !== 'custom') return previous;
      const selected = previous[action][kind];
      return { ...previous, [action]: { ...previous[action], [kind]: selected.includes(value) ? selected.filter(v => v !== value) : [...selected, value] } };
    });
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
      <DialogHeader><DialogTitle className="flex gap-2 items-center"><ShieldCheck size={18} />{t('kb.permissions.title')}</DialogTitle>
        <DialogDescription>{t('kb.permissions.hierarchy')}</DialogDescription>
      </DialogHeader>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <legend className="sr-only">{t('kb.permissions.mode')}</legend>
        {([{ id: 'self', icon: Lock }, { id: 'workspace', icon: Users }, { id: 'inherit', icon: CornerDownRight }, { id: 'custom', icon: SlidersHorizontal }] as const).map(option => <label key={option.id} className={`flex items-start gap-3 rounded-xl border p-4 text-sm ${preset === option.id ? 'border-primary bg-primary/5' : 'hover:bg-muted/40'} ${option.id === 'workspace' && privateDraft ? 'opacity-50' : ''}`}>
          <input className="mt-1" type="radio" name="kb-permission-mode" checked={preset === option.id} disabled={(option.id === 'self' || option.id === 'workspace') && (!currentMemberId || (option.id === 'workspace' && privateDraft))} onChange={() => {
            setPreset(option.id);
            setDraft(previous => option.id === 'inherit' ? { mode: 'inherit' } : option.id === 'custom' ? previous.mode === 'custom' ? previous : customPolicy() : knowledgePermissionPreset(option.id, currentMemberId));
          }} />
          <span className="min-w-0"><span className="mb-1 flex items-center gap-2 font-medium"><option.icon size={15} />{t(`kb.permissions.${option.id === 'self' ? 'onlyMe' : option.id === 'workspace' ? 'workspaceMembers' : option.id}`)}</span><span className="block text-xs leading-5 text-muted-foreground">{t(option.id === 'inherit' ? hasParent ? 'kb.permissions.inheritParent' : 'kb.permissions.inheritRoot' : option.id === 'custom' ? 'kb.permissions.matchAny' : `kb.permissions.${option.id}Hint`)}</span></span>
        </label>)}
      </fieldset>
      {hasParent && <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">{t('kb.permissions.parentLimit')}</p>}
      {privateDraft && <p className="rounded-lg bg-muted px-3 py-2 text-xs leading-5 text-muted-foreground">{t('kb.permissions.privateDraftHint')}</p>}
      {preset === 'custom' && draft.mode === 'custom' && <div className="space-y-4">
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm">{t('kb.permissions.emptyDenied')}</p>
        <div className="flex gap-1 rounded-lg bg-muted p-1" role="group" aria-label={t('kb.permissions.actionTabs')}>{(['view', 'edit', 'comment'] as const).map(action => <button key={action} type="button" disabled={busy} aria-pressed={actionTab === action} className={`min-h-10 flex-1 rounded-md px-2 text-sm ${actionTab === action ? 'bg-card text-primary shadow-sm' : 'text-muted-foreground'}`} onClick={() => setActionTab(action)}>{t(`kb.permissions.${action}`)}</button>)}</div>
        {(['view', 'edit', 'comment'] as const).filter(action => action === actionTab).map(action => <fieldset key={action} disabled={busy} className="rounded-lg border p-4">
          <legend className="px-1 text-sm font-semibold">{t(`kb.permissions.${action}`)}</legend>
          <div className="grid sm:grid-cols-3 gap-4">
            <fieldset><legend className="mb-2 text-xs text-muted-foreground">{t('kb.permissions.roles')}</legend>
              <div className="space-y-2">{(['member', 'admin', 'super_admin'] as const).map(role => <label key={role} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={draft[action].roles.includes(role)} onChange={() => toggle(action, 'roles', role)} />{t(`kb.permissions.role.${role}`)}
              </label>)}</div>
            </fieldset>
            <fieldset><legend className="mb-2 text-xs text-muted-foreground">{t('kb.permissions.positions')}</legend>
              <div className="max-h-44 overflow-auto space-y-2">{positions.length ? positions.map(position => <label key={position} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={draft[action].positions.includes(position)} onChange={() => toggle(action, 'positions', position)} /><span className="break-words">{position}</span>
              </label>) : <p className="text-xs text-muted-foreground">{t('kb.permissions.noPositions')}</p>}</div>
            </fieldset>
            <fieldset><legend className="mb-2 text-xs text-muted-foreground">{t('kb.permissions.members')}</legend>
              <div className="max-h-44 overflow-auto space-y-2">{activeUsers.map(user => <label key={user.id} className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1" checked={draft[action].member_ids.includes(user.id)} onChange={() => toggle(action, 'member_ids', user.id)} /><span>{user.name}<span className="block text-xs text-muted-foreground">{user.jobTitle}</span></span>
              </label>)}{draft[action].member_ids.filter(id => !activeUsers.some(u => u.id === id)).map(id => <label key={id} className="flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked onChange={() => toggle(action, 'member_ids', id)} />{users.find(u => u.id === id)?.name || t('kb.member')} · {t('kb.permissions.inactiveMember')}
              </label>)}</div>
            </fieldset>
          </div>
        </fieldset>)}
        <p className="text-xs text-muted-foreground">{t('kb.permissions.viewRequired')}</p>
      </div>}
      <DialogFooter><Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>{t('kb.cancel')}</Button>
        <Button disabled={busy} onClick={() => void onSave(draft)}>{busy ? t('kb.saving') : t('kb.save')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
