import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Link, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { DialogFooter } from '@/components/ui/dialog';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { copyText } from '@/lib/clipboard';
import { MEMBER_ROLE_OPTIONS, selectionRoleLabel, type MemberRoleSelection } from '@/lib/memberRoleSelection';
import {
  createMemberInvitation, invitationErrorKey, listMemberInvitations, memberInvitationUrl,
  revokeMemberInvitation, type CreatedInvitation, type InvitationError, type InvitationMetadata,
} from '@/lib/memberInvitations';

const inputClass = 'w-full rounded-md border border-input bg-background px-3 py-2.5 text-sm text-foreground outline-none focus:ring-2 focus:ring-ring';
const buttonClass = 'min-h-11 rounded-md px-3 py-2 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50';

interface Props { canEditGrant: boolean; jobTitles: string[]; onClose: () => void }

const MemberInvitationPanel = ({ canEditGrant, jobTitles, onClose }: Props) => {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [role, setRole] = useState<MemberRoleSelection>('member');
  const [jobTitle, setJobTitle] = useState('');
  const [invitations, setInvitations] = useState<InvitationMetadata[]>([]);
  const [created, setCreated] = useState<CreatedInvitation | null>(null);
  const [listError, setListError] = useState<InvitationError | null>(null);
  const [actionError, setActionError] = useState<InvitationError | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const refreshRevision = useRef(0);
  const mounted = useRef(true);
  const formatDate = (value: string) => new Date(value).toLocaleString(i18n.language);
  const inviteUrl = created ? memberInvitationUrl(created.inviteToken, created.inviteUrl) : '';

  const refresh = useCallback(async () => {
    const revision = ++refreshRevision.current;
    setListLoading(true);
    const result = await listMemberInvitations();
    if (!mounted.current || refreshRevision.current !== revision) return;
    setListError(result.error);
    if (result.data) {
      setInvitations(result.data.invitations);
      setCreated(current => {
        if (!current) return null;
        const fresh = result.data.invitations.find(item => item.id === current.invitation.id);
        return fresh?.status === 'pending' && Date.parse(fresh.expiresAt) > Date.now()
          ? { ...current, invitation: fresh } : null;
      });
    }
    setListLoading(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => { mounted.current = false; ++refreshRevision.current; };
  }, [refresh]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (creating || revoking) return;
    setCreating(true);
    setActionError(null);
    const result = await createMemberInvitation({
      role: canEditGrant && role !== 'qa_admin' ? role : 'member',
      isQaAdmin: canEditGrant && role === 'qa_admin',
      jobTitle: canEditGrant ? jobTitle.trim() : '',
    });
    if (!mounted.current) return;
    if (result.error) {
      setActionError(result.error);
      toast.error(t(invitationErrorKey(result.error)));
    } else {
      setCreated(result.data);
      setCopied(false);
      setInvitations(list => [result.data.invitation, ...list.filter(item => item.id !== result.data.invitation.id)]);
      toast.success(t('memberInvite.created'));
      await refresh();
    }
    setCreating(false);
  };

  const handleCopy = async () => {
    if (!inviteUrl || !created) return;
    if (created.invitation.status !== 'pending' || Date.parse(created.invitation.expiresAt) <= Date.now()) {
      setCreated(null);
      toast.error(t('memberInvite.errors.invalid_token'));
      return;
    }
    const success = await copyText(inviteUrl);
    setCopied(success);
    if (success) toast.success(t('memberInvite.copied'));
    else toast.error(t('memberInvite.copyFailed'));
  };

  const handleRevoke = async (invitationId: string) => {
    if (creating || revoking) return;
    setRevoking(invitationId);
    setActionError(null);
    const result = await revokeMemberInvitation(invitationId);
    if (!mounted.current) return;
    if (result.error) {
      setActionError(result.error);
      toast.error(t(invitationErrorKey(result.error)));
    } else {
      setInvitations(list => list.map(item => item.id === invitationId ? { ...item, status: 'revoked' } : item));
      if (created?.invitation.id === invitationId) setCreated(null);
      setConfirmRevoke(null);
      toast.success(t('memberInvite.revoked'));
      await refresh();
    }
    setRevoking(null);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain pr-1 [scroll-padding-block:1rem]">
        <p className="text-sm leading-relaxed text-muted-foreground">{t('memberInvite.description')}</p>
        <form onSubmit={handleCreate} className="space-y-3">
          {canEditGrant ? <>
            <div>
              <label htmlFor={`${id}-role`} className="mb-1 block text-sm font-medium">{t('memberList.roleLabel')}</label>
              <SearchableSelect id={`${id}-role`} value={role} onChange={event => setRole(event.target.value as MemberRoleSelection)} className={inputClass} disabled={creating}>
                {MEMBER_ROLE_OPTIONS.map(value => <option key={value} value={value}>{selectionRoleLabel(value)}</option>)}
              </SearchableSelect>
            </div>
            <div>
              <label htmlFor={`${id}-title`} className="mb-1 block text-sm font-medium">{t('memberList.jobTitleLabel')}</label>
              <input id={`${id}-title`} list={`${id}-titles`} value={jobTitle} maxLength={200} disabled={creating} onChange={event => setJobTitle(event.target.value)} className={inputClass} placeholder={t('memberList.jobTitlePlaceholder')} autoComplete="off" />
              <datalist id={`${id}-titles`}>{jobTitles.map(value => <option key={value} value={value} />)}</datalist>
            </div>
          </> : <p className="rounded-md bg-muted p-3 text-sm">{t('memberInvite.memberGrant')}</p>}
          <p className="text-xs text-muted-foreground">{t('memberInvite.validity')}</p>
          <button type="submit" disabled={creating || !!revoking} aria-busy={creating} className={`${buttonClass} flex w-full items-center justify-center gap-2 bg-primary text-primary-foreground hover:bg-primary/90`}>
            <Link size={16} aria-hidden="true" />{t(creating ? 'memberInvite.creating' : 'memberInvite.createLink')}
          </button>
        </form>
        {actionError && <p role="alert" className="text-sm text-destructive">{t(invitationErrorKey(actionError))}</p>}
        {created && <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3" aria-live="polite">
          <label htmlFor={`${id}-link`} className="block text-sm font-medium">{t('memberInvite.linkLabel')}</label>
          <input id={`${id}-link`} readOnly value={inviteUrl} onFocus={event => event.currentTarget.select()} className={inputClass} />
          <button type="button" onClick={handleCopy} disabled={Date.parse(created.invitation.expiresAt) <= Date.now()} className={`${buttonClass} flex w-full items-center justify-center gap-2 border border-border hover:bg-accent`}>
            <Copy size={16} aria-hidden="true" />{t(copied ? 'memberInvite.copied' : 'memberInvite.copyLink')}
          </button>
          <p className="text-xs text-muted-foreground">{t('memberInvite.expiresAt', { date: formatDate(created.invitation.expiresAt) })}</p>
          <p className="text-xs text-muted-foreground">{t('memberInvite.copyBeforeClose')}</p>
        </div>}
        <section className="space-y-2 border-t border-border pt-3" aria-label={t('memberInvite.listTitle')}>
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">{t('memberInvite.listTitle')}</h2>
            <button type="button" onClick={() => void refresh()} disabled={listLoading || creating || !!revoking} aria-label={t('memberInvite.refresh')} className={`${buttonClass} hover:bg-accent`}><RefreshCw size={16} aria-hidden="true" /></button>
          </div>
          {listLoading && <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>}
          {listError && <p role="alert" className="text-sm text-destructive">{t('memberInvite.loadFailed')} {t(invitationErrorKey(listError))}</p>}
          {!listLoading && !listError && !invitations.length && <p className="text-sm text-muted-foreground">{t('memberInvite.empty')}</p>}
          <ul className="space-y-2">{invitations.map(item => {
            const status = item.status === 'pending' && Date.parse(item.expiresAt) <= Date.now() ? 'expired' : item.status;
            return <li key={item.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="font-medium">{selectionRoleLabel(item.isQaAdmin ? 'qa_admin' : item.role)}{item.jobTitle ? ` · ${item.jobTitle}` : ''}</span>
                <span className="rounded bg-muted px-2 py-1 text-xs">{t(`memberInvite.status.${status}`)}</span>
              </div>
              <p className="text-xs text-muted-foreground">{t('memberInvite.createdAt', { date: formatDate(item.createdAt) })}</p>
              <p className="text-xs text-muted-foreground">{t('memberInvite.expiresAt', { date: formatDate(item.expiresAt) })}</p>
              {status === 'unavailable' && <p className="text-xs text-muted-foreground">{t('memberInvite.unavailableHint')}</p>}
              {(status === 'pending' || status === 'unavailable') && (confirmRevoke === item.id ? <div className="space-y-2">
                <p className="text-xs">{t('memberInvite.revokeConfirm')}</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" disabled={creating || !!revoking} onClick={() => void handleRevoke(item.id)} className={`${buttonClass} bg-destructive text-destructive-foreground`}>{t(revoking === item.id ? 'memberInvite.revoking' : 'memberInvite.confirmRevoke')}</button>
                  <button type="button" disabled={!!revoking} onClick={() => setConfirmRevoke(null)} className={`${buttonClass} border border-border hover:bg-accent`}>{t('common.cancel')}</button>
                </div>
              </div> : <button type="button" disabled={creating || !!revoking} onClick={() => setConfirmRevoke(item.id)} className={`${buttonClass} text-destructive hover:bg-destructive/10`}>{t('memberInvite.revoke')}</button>)}
            </li>;
          })}</ul>
        </section>
      </div>
      <DialogFooter className="mt-3 border-t border-border pt-3">
        <button type="button" onClick={onClose} className={`${buttonClass} border border-border hover:bg-accent`}>{t('common.close')}</button>
      </DialogFooter>
    </div>
  );
};

export default MemberInvitationPanel;
