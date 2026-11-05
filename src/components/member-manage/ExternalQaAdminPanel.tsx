import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import AccountCredentialsDialog, { type AccountCredential } from '@/components/AccountCredentialsDialog';
import { ProjectCheckboxList } from '@/components/project/ProjectOptions';
import { useProjectContext } from '@/context/ProjectContext';
import { callFunction } from '@/lib/callFunction';
import { groupProjectsByLine } from '@/lib/projectGroups';
import { randomUUID } from '@/lib/generateId';

interface ExternalQaAccount {
  id: string;
  name: string;
  email: string | null;
  isActive: boolean;
  projectIds: string[];
  revision: number;
  registrationId?: string;
  registrationPending?: boolean;
  credentialRecoveryAvailable?: boolean;
}
type AccountDraft = Omit<ExternalQaAccount, 'id' | 'revision' | 'email'> & {
  id?: string; revision?: number; email: string; initialPassword: string; requestId?: string; recover?: boolean;
};
interface AdminResponse {
  accounts?: ExternalQaAccount[];
  account?: ExternalQaAccount;
  temporaryPassword?: string;
  error?: string;
}
const newDraft = (): AccountDraft => ({ name: '', email: '', isActive: true, projectIds: [], initialPassword: '', requestId: randomUUID() });
const editable = (account: ExternalQaAccount): AccountDraft => ({ ...account, email: account.email || '', initialPassword: '' });

export default function ExternalQaAdminPanel() {
  const { t } = useTranslation();
  const { allProjects, productLines } = useProjectContext();
  const [accounts, setAccounts] = useState<ExternalQaAccount[] | null>(null);
  const [draft, setDraft] = useState<AccountDraft | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [credential, setCredential] = useState<AccountCredential | null>(null);
  const readAccounts = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await callFunction<AdminResponse>('external-qa-admin', { action: 'list' });
      if (!result.ok || !Array.isArray(result.data?.accounts)) throw new Error('external_qa_request_failed');
      setAccounts(result.data.accounts);
    } catch {
      setError('external_qa_request_failed');
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void readAccounts(); }, [readAccounts]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    if (draft.initialPassword && ([...draft.initialPassword].length < 8 || new TextEncoder().encode(draft.initialPassword).length > 72)) {
      setError('external_qa_invalid_password');
      return;
    }
    setError('');
    setSaving(true);
    try {
      const { email, name, isActive, projectIds, initialPassword, requestId, id, revision, registrationId, recover } = draft;
      const password = initialPassword ? { initialPassword } : {};
      const payload = recover
        ? { action: 'recover', registrationId, id, revision, ...password }
        : id ? { action: 'update', id, revision, name, isActive, projectIds }
          : { action: 'create', requestId, name, email, isActive, projectIds, ...password };
      const result = await callFunction<AdminResponse>('external-qa-admin', payload);
      const { account, temporaryPassword } = result.data ?? {};
      if (!result.ok || !account) {
        setError(result.data?.error || 'external_qa_request_failed');
        return;
      }
      setAccounts(previous => [...(previous ?? []).filter(a => a.id !== account.id),
        { ...(previous ?? []).find(a => a.id === account.id), ...account }]
        .sort((a, b) => a.name.localeCompare(b.name)));
      setDraft(null);
      if (temporaryPassword && account.email) {
        setCredential({ name: account.name, email: account.email, password: temporaryPassword });
      }
      toast.success(t('externalQaAdmin.saved'));
    } catch {
      setError('external_qa_request_failed');
    } finally {
      setSaving(false);
    }
  }

  const selected = draft?.id ? accounts?.find(a => a.id === draft.id) : undefined;
  const groups = groupProjectsByLine(productLines, allProjects, { keepIds: selected?.projectIds });
  const projectNames = new Map(allProjects.map(project => [project.id, project.name]));
  return <div className="space-y-3 rounded-lg border border-border bg-card p-3 md:p-4">
    <p className="text-sm text-muted-foreground">{t('externalQaAdmin.description')}</p>
    <div className="flex flex-wrap items-center gap-2">
      <button type="button" disabled={saving || loading || accounts === null} onClick={() => { setError(''); setDraft(newDraft()); }}
        className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50">
        {t('externalQaAdmin.create')}
      </button>
      {loading && <span role="status" className="text-sm text-muted-foreground">{t('common.loading')}</span>}
      {error && !draft && <button type="button" className="text-sm underline" onClick={() => void readAccounts()}>{t('common.retry')}</button>}
    </div>
    {error && <p role="alert" className="text-sm text-destructive">{t(`externalQaAdmin.errors.${error}`, { defaultValue: t('externalQaAdmin.errors.external_qa_request_failed') })}</p>}
    {accounts?.length === 0 && <p className="text-sm text-muted-foreground">{t('externalQaAdmin.empty')}</p>}
    {!!accounts?.length && <ul className="divide-y divide-border">
      {accounts.map(account => <li key={account.id} className="flex items-center justify-between gap-3 py-2">
        <div className="min-w-0 text-sm">
          <div className="flex flex-wrap items-center gap-x-2">
            <strong className="break-all">{account.name}</strong>
            <span className="text-xs text-muted-foreground">{t(account.registrationPending ? 'externalQaAdmin.pending' : account.isActive ? 'externalQaAdmin.active' : 'externalQaAdmin.inactive')}</span>
          </div>
          <p className="break-all text-xs text-muted-foreground">{account.email}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {account.projectIds.map(id => projectNames.get(id) ?? id).join(' · ') || t('externalQaAdmin.noProjects')}
          </p>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
        {account.credentialRecoveryAvailable && <button type="button" disabled={saving}
          onClick={() => { setError(''); setDraft({ ...editable(account), recover: true }); }}
          aria-label={`${t('externalQaAdmin.recover')}: ${account.name}`} className="rounded-md border border-border px-3 py-2 text-sm">
          {t('externalQaAdmin.recover')}
        </button>}
        <button type="button" disabled={saving || account.registrationPending} onClick={() => { setError(''); setDraft(editable(account)); }}
          aria-label={`${t('common.edit')}: ${account.name}`} className="rounded-md border border-border px-3 py-2 text-sm">
          {t('common.edit')}
        </button>
        </div>
      </li>)}
    </ul>}
    {draft && <form onSubmit={save} className="space-y-3 rounded-md border border-border p-3">
      <fieldset disabled={saving} className="space-y-3 disabled:opacity-70">
        <legend className="text-sm font-semibold">{t(draft.recover ? 'externalQaAdmin.recover' : draft.id ? 'externalQaAdmin.edit' : 'externalQaAdmin.create')}</legend>
        <div className="grid gap-3 md:grid-cols-2">
          <label className="space-y-1 text-sm"><span>{t('accountCredentials.name')}</span>
            <input required readOnly={draft.recover} maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
          </label>
          <label className="space-y-1 text-sm"><span>Email</span>
            <input type="email" required={!draft.id} readOnly={!!draft.id} maxLength={254} value={draft.email}
              onChange={event => setDraft({ ...draft, email: event.target.value })}
              className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
          </label>
        </div>
        {(!draft.id || draft.recover) && <label className="block space-y-1 text-sm"><span>{t('externalQaAdmin.initialPassword')}</span>
          <input type="password" autoComplete="new-password" aria-label={t('externalQaAdmin.initialPassword')}
            aria-describedby="external-qa-initial-password-hint" value={draft.initialPassword}
            onChange={event => setDraft({ ...draft, initialPassword: event.target.value })}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5" />
          <span id="external-qa-initial-password-hint" className="block text-xs text-muted-foreground">{t('externalQaAdmin.initialPasswordHint')}</span>
        </label>}
        {draft.recover && <p className="text-sm text-muted-foreground">{t('externalQaAdmin.recoverHint')}</p>}
        <fieldset disabled={draft.recover} className="space-y-3">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft.isActive}
          onChange={event => setDraft({ ...draft, isActive: event.target.checked })} />{t('externalQaAdmin.active')}</label>
        <div className="text-sm font-medium">{t('externalQaAdmin.projects')}</div>
        <div className="max-h-52 overflow-auto rounded-md border border-border">
          {groups.length ? <ProjectCheckboxList groups={groups} selected={draft.projectIds}
            onToggle={id => setDraft({ ...draft, projectIds: draft.projectIds.includes(id)
              ? draft.projectIds.filter(value => value !== id) : [...draft.projectIds, id] })} />
            : <p className="p-2 text-sm text-muted-foreground">{t('externalQaAdmin.noProjects')}</p>}
        </div>
        </fieldset>
        <div className="flex gap-2">
          <button type="submit" className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground">{t('common.save')}</button>
          <button type="button" onClick={() => { setError(''); setDraft(null); }} className="rounded-md border border-border px-3 py-2 text-sm">{t('common.cancel')}</button>
          {['external_qa_stale', 'external_qa_registration_pending'].includes(error) && <button type="button" onClick={() => { setDraft(null); void readAccounts(); }}
            className="rounded-md border border-border px-3 py-2 text-sm">{t('common.retry')}</button>}
        </div>
      </fieldset>
    </form>}
    {credential && <AccountCredentialsDialog credentials={[credential]} onClose={() => setCredential(null)} />}
  </div>;
}
