import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldCheck } from 'lucide-react';
import type { User } from '@/types';
import type { KnowledgePolicy, KnowledgeRule, KnowledgeAction } from '@/types/knowledge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const emptyRule = (): KnowledgeRule => ({ roles: [], positions: [], member_ids: [] });
const customPolicy = (): KnowledgePolicy => ({ mode: 'custom', view: emptyRule(), edit: emptyRule(), comment: emptyRule() });

export default function KnowledgePermissionsDialog({ open, onOpenChange, policy, users, hasParent, busy, onSave }:
  { open: boolean; onOpenChange: (open: boolean) => void; policy: KnowledgePolicy; users: User[]; hasParent: boolean;
    busy: boolean; onSave: (policy: KnowledgePolicy) => Promise<void> }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<KnowledgePolicy>(policy);
  const policyKey = JSON.stringify(policy);
  useEffect(() => { if (open) setDraft(JSON.parse(policyKey) as KnowledgePolicy); }, [open, policyKey]);
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
      <fieldset disabled={busy} className="space-y-3">
        <legend className="sr-only">{t('kb.permissions.mode')}</legend>
        <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input className="mt-1" type="radio" name="kb-permission-mode" checked={draft.mode === 'inherit'} onChange={() => setDraft({ mode: 'inherit' })} />
          <span><span className="font-medium block">{t('kb.permissions.inherit')}</span><span className="text-muted-foreground">{t(hasParent ? 'kb.permissions.inheritParent' : 'kb.permissions.inheritRoot')}</span></span>
        </label>
        <label className="flex items-start gap-2 rounded-lg border p-3 text-sm"><input className="mt-1" type="radio" name="kb-permission-mode" checked={draft.mode === 'custom'} onChange={() => setDraft(customPolicy())} />
          <span><span className="font-medium block">{t('kb.permissions.custom')}</span><span className="text-muted-foreground">{t('kb.permissions.matchAny')}</span></span>
        </label>
      </fieldset>
      {draft.mode === 'custom' && <div className="space-y-4">
        <p className="rounded-md bg-amber-500/10 px-3 py-2 text-sm">{t('kb.permissions.emptyDenied')}</p>
        {(['view', 'edit', 'comment'] as const).map(action => <fieldset key={action} disabled={busy} className="rounded-lg border p-3">
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
