import { SearchableSelect } from '@/components/ui/searchable-select';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, FileText, KeyRound, Mail, Upload, Users } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import UpgradePrompt from '@/components/UpgradePrompt';
import AccountCredentialsDialog, { type AccountCredential } from '@/components/AccountCredentialsDialog';
import { useConfirmDialog } from '@/components/ConfirmDialog';
import { callFunction, DEMO_BLOCKED } from '@/lib/callFunction';
import { accountListTemplate, parseAccountList } from '@/lib/jiraAccountMapping';
import { logActivity } from '@/lib/activityLog';

// Jira CSV import, in two steps:
//   1. choosing a file runs a preview (the backend writes nothing): counts,
//      every person in the CSV and what happens to them, missing columns;
//   2. optionally a "name, email" list gives people a real login; then
//      「開始匯入」 runs the real import (professional tier — it first clears
//      tasks, sprints, comments …).
// Temporary passwords (no email sending configured) are shown once.

type PlanKind = 'existing' | 'activate' | 'new_account' | 'new_name_only' | 'error';

interface PersonSummary {
  name: string;
  roles: string[];
  issueCount: number;
  plan: PlanKind;
  memberName?: string;
  email?: string;
  hasLogin?: boolean;
  matchedBy?: 'name' | 'email';
}

interface AccountIssue {
  code: string;
  name: string;
  email?: string;
  detail?: string;
}

interface StatusMappingRow {
  jiraStatus: string;
  jiraCategory: string;
  issueCount: number;
  statusId: string;
  statusName: string;
  via: 'name' | 'alias' | 'category' | 'default';
  substituted: boolean;
}

interface ImportResponse {
  success?: boolean;
  dryRun?: boolean;
  canImport?: boolean;
  stats?: {
    totalRows?: number;
    tasksParsed?: number;
    commentsParsed?: number;
    specsParsed?: number;
    sprintsParsed?: number;
    subtasksLinked?: number;
    epicChildren?: number;
    attachmentsParsed?: number;
    newMembers?: string[];
    newProjects?: string[];
    tasksInserted?: number;
    commentsInserted?: number;
    specsInserted?: number;
    sprintsCreated?: number;
  };
  people?: PersonSummary[];
  accountErrors?: AccountIssue[];
  accountWarnings?: AccountIssue[];
  unresolvedCommenters?: number;
  loginMethod?: 'invite' | 'temp_password';
  statusMapping?: StatusMappingRow[];
  /** Steps after the wipe that only warned (sprints, departments, …). */
  warnings?: string[];
  accounts?: {
    method: 'invite' | 'temp_password';
    invited: { name: string; email: string }[];
    credentials: AccountCredential[];
    failed: { name: string; email: string; reason: string }[];
  };
  // error replies
  error?: string;
  message?: string;
  missingColumns?: { field: string; accepted: string[] }[];
  detectedColumns?: string[];
  /** import_failed: the step that failed after the wipe, and what landed. */
  step?: string;
  detail?: string;
  partial?: { tasksInserted?: number; commentsInserted?: number; specsInserted?: number };
}

interface JiraImportCardProps {
  currentMemberId: string;
  isPro: boolean;
  refreshAll: () => Promise<unknown>;
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err));

const toAccounts = (text: string) => parseAccountList(text).accounts.map(({ name, email }) => ({ name, email }));

// Jira writes times in the exporting user's zone; the admin's browser zone is
// the best first guess, a few common zones cover the rest.
const BROWSER_TIME_ZONE = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Taipei';
  } catch {
    return 'Asia/Taipei';
  }
})();
const TIME_ZONES = Array.from(new Set([
  BROWSER_TIME_ZONE, 'Asia/Taipei', 'Asia/Shanghai', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Asia/Singapore',
  'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney',
]));

const JiraImportCard = ({ currentMemberId, isPro, refreshAll }: JiraImportCardProps) => {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const listInputRef = useRef<HTMLInputElement>(null);
  const { confirm, ConfirmDialog } = useConfirmDialog();
  const [csv, setCsv] = useState<{ name: string; text: string } | null>(null);
  const [busy, setBusy] = useState<'reading' | 'previewing' | 'importing' | null>(null);
  const [preview, setPreview] = useState<ImportResponse | null>(null);
  const [failure, setFailure] = useState<ImportResponse | null>(null);
  const [accountText, setAccountText] = useState('');
  const [appliedText, setAppliedText] = useState('');
  const [result, setResult] = useState<ImportResponse | null>(null);
  const [credentials, setCredentials] = useState<AccountCredential[]>([]);
  const [showAllColumns, setShowAllColumns] = useState(false);
  const [timeZone, setTimeZone] = useState(BROWSER_TIME_ZONE);

  const parsedList = useMemo(() => parseAccountList(accountText), [accountText]);
  const listDirty = accountText.trim() !== appliedText.trim();
  const people = useMemo(() => preview?.people || [], [preview]);
  const accountErrors = preview?.accountErrors || [];
  const accountWarnings = preview?.accountWarnings || [];
  const canImport = isPro && preview?.canImport !== false;

  const issueText = (issue: AccountIssue) =>
    t(`adminImportExport.accountIssue.${issue.code}`, {
      name: issue.name,
      email: issue.email || '',
      detail: issue.detail || '',
      defaultValue: `${issue.name}: ${issue.code}`,
    });

  const failureText = (res: ImportResponse | null): string => {
    const code = res?.error || '';
    if (code === DEMO_BLOCKED) return t('adminImportExport.demoBlocked');
    if (code === 'no_data_rows') return t('adminImportExport.noDataRows');
    if (code === 'no_tasks') return t('adminImportExport.noTasks');
    if (code === 'account_errors') return t('adminImportExport.accountErrorsTitle');
    if (code === 'no_statuses') return t('adminImportExport.noStatuses');
    if (code === 'status_missing') return t('adminImportExport.statusMissing');
    if (code === 'api_key_forbidden') return t('adminImportExport.apiKeyForbidden');
    if (code === 'import_failed') return t('adminImportExport.importIncomplete');
    return `${t('adminImportExport.importFailed')}: ${res?.message || code || '—'}`;
  };

  const runPreview = async (text: string, listText: string, keepOnError: boolean) => {
    setBusy('previewing');
    setResult(null);
    try {
      const res = await callFunction<ImportResponse>('import-jira', { csv: text, dryRun: true, accounts: toAccounts(listText), timeZone });
      if (!res.ok || !res.data?.success) {
        if (keepOnError) toast.error(failureText(res.data));
        else {
          setPreview(null);
          setFailure(res.data || { error: `HTTP ${res.status}` });
        }
        return;
      }
      setFailure(null);
      setPreview(res.data);
      setAppliedText(listText);
    } catch (err) {
      if (keepOnError) toast.error(`${t('adminImportExport.importError')} ${errMsg(err)}`);
      else setFailure({ error: 'network', message: errMsg(err) });
    } finally {
      setBusy(null);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setBusy('reading');
    setPreview(null);
    setFailure(null);
    setResult(null);
    setShowAllColumns(false);
    try {
      const text = await file.text();
      setCsv({ name: file.name, text });
      await runPreview(text, accountText, false);
    } catch (err) {
      setFailure({ error: 'read', message: errMsg(err) });
      setBusy(null);
    }
  };

  const handleListFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAccountText(await file.text());
  };

  const downloadTemplate = () => {
    const names = people
      .filter((p) => p.plan === 'new_name_only' || (p.plan === 'existing' && !p.hasLogin))
      .map((p) => p.name);
    const blob = new Blob(
      [accountListTemplate([t('adminImportExport.accounts.templateName'), 'Email'], names)],
      { type: 'text/csv;charset=utf-8;' }
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jira-people-emails.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async () => {
    if (!csv || !preview) return;
    const ok = await confirm({
      title: t('adminImportExport.importConfirmTitle'),
      description: t('adminImportExport.importConfirm'),
      confirmLabel: t('adminImportExport.startImport'),
      destructive: true,
    });
    if (!ok) return;
    setBusy('importing');
    try {
      const res = await callFunction<ImportResponse>('import-jira', { csv: csv.text, accounts: toAccounts(appliedText), timeZone });
      if (!res.ok || !res.data?.success) {
        setFailure(res.data || { error: `HTTP ${res.status}` });
        toast.error(failureText(res.data));
        if (res.data?.error === 'import_failed') {
          // The old data is gone and part of the new data landed: the preview
          // is stale, logins already created still need their passwords shown.
          setPreview(null);
          setCredentials(res.data.accounts?.credentials || []);
          await refreshAll();
        }
        return;
      }
      const count = res.data.stats?.tasksInserted || 0;
      setResult(res.data);
      setPreview(null);
      setFailure(null);
      setCredentials(res.data.accounts?.credentials || []);
      toast.success(t('adminImportExport.importSuccessToast', { count }));
      if (currentMemberId) {
        await logActivity(currentMemberId, 'import_jira', t('adminImportExport.activityImported', { count }), undefined, undefined, 'system');
      }
      await refreshAll();
    } catch (err) {
      toast.error(`${t('adminImportExport.importError')} ${errMsg(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const planCell = (p: PersonSummary) => {
    switch (p.plan) {
      case 'existing':
        return (
          <>
            <span className="text-emerald-600 dark:text-emerald-400">
              {p.hasLogin ? t('adminImportExport.plan.existing') : t('adminImportExport.plan.existingNoLogin')}
            </span>
            {(p.matchedBy === 'email' || (p.memberName && p.memberName !== p.name)) && (
              <span className="block text-muted-foreground">
                {p.matchedBy === 'email'
                  ? t('adminImportExport.plan.matchedByEmail', { name: p.memberName })
                  : t('adminImportExport.plan.matchedMember', { name: p.memberName })}
              </span>
            )}
          </>
        );
      case 'activate':
        return (
          <>
            <span className="text-primary">{t('adminImportExport.plan.activate')}</span>
            <span className="block text-muted-foreground break-all">{p.email}</span>
          </>
        );
      case 'new_account':
        return (
          <>
            <span className="text-primary">{t('adminImportExport.plan.newAccount')}</span>
            <span className="block text-muted-foreground break-all">{p.email}</span>
          </>
        );
      case 'new_name_only':
        return <span className="text-muted-foreground">{t('adminImportExport.plan.newNameOnly')}</span>;
      default:
        return <span className="text-destructive">{t('adminImportExport.plan.error')}</span>;
    }
  };

  const counts = useMemo(() => {
    const c = { existing: 0, login: 0, nameOnly: 0 };
    for (const p of people) {
      if (p.plan === 'existing') c.existing++;
      else if (p.plan === 'activate' || p.plan === 'new_account') c.login++;
      else if (p.plan === 'new_name_only') c.nameOnly++;
    }
    return c;
  }, [people]);

  const statusText =
    busy === 'reading' ? t('adminImportExport.readingCsv')
      : busy === 'previewing' ? t('adminImportExport.previewing')
        : busy === 'importing' ? t('adminImportExport.importing')
          : null;

  const missing = failure?.error === 'missing_columns' ? failure.missingColumns || [] : [];
  const detected = failure?.detectedColumns || [];
  const failureIssues = failure?.error === 'account_errors' ? failure.accountErrors || [] : [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-lg">
          <Download size={20} className="text-primary" />
          {t('adminImportExport.importTitle')}
        </CardTitle>
        <CardDescription>{isPro ? t('adminImportExport.importDesc') : t('adminImportExport.previewDesc')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">
          {isPro ? t('adminImportExport.previewFirstHint') : t('adminImportExport.previewNote')}
        </p>
        <input ref={fileInputRef} type="file" accept=".csv,text/csv" onChange={handleFileSelect} className="hidden" />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={() => fileInputRef.current?.click()} disabled={!!busy} variant={preview ? 'outline' : 'default'} className="gap-2">
            <Download size={16} />
            {csv ? t('adminImportExport.chooseAnotherCsv') : t('adminImportExport.chooseCsvButton')}
          </Button>
          {csv && <span className="text-xs text-muted-foreground flex items-center gap-1 break-all"><FileText size={12} />{csv.name}</span>}
        </div>

        {statusText && (
          <div className="p-3 rounded-md bg-muted text-sm text-muted-foreground">
            <p className="flex items-center gap-2"><FileText size={14} />{statusText}</p>
          </div>
        )}

        {failure && !busy && (
          <div className="p-3 rounded-md border border-destructive/40 bg-destructive/5 text-sm space-y-2" role="alert">
            {failure.error === 'missing_columns' ? (
              <>
                <p className="font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle size={14} className="flex-shrink-0" />
                  {t('adminImportExport.missingColumnsTitle')}
                </p>
                <ul className="space-y-0.5 text-foreground">
                  {missing.map((m) => (
                    <li key={m.field}>
                      • {t(`adminImportExport.fields.${m.field}`, { defaultValue: m.field })}：
                      <span className="text-muted-foreground"> {t('adminImportExport.acceptedNames', { names: m.accepted.join(' / ') })}</span>
                    </li>
                  ))}
                </ul>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">{t('adminImportExport.detectedColumns', { count: detected.length })}</p>
                  {detected.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {(showAllColumns ? detected : detected.slice(0, 40)).map((h) => (
                        <span key={h} className="text-[11px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">{h}</span>
                      ))}
                      {!showAllColumns && detected.length > 40 && (
                        <button type="button" onClick={() => setShowAllColumns(true)} className="text-[11px] text-primary hover:underline">
                          {t('adminImportExport.showAllColumns', { count: detected.length - 40 })}
                        </button>
                      )}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('adminImportExport.noColumnsDetected')}</p>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t('adminImportExport.missingColumnsHint')}</p>
              </>
            ) : (
              <>
                <p className="font-medium text-destructive flex items-center gap-1.5">
                  <AlertTriangle size={14} className="flex-shrink-0" />
                  {failureText(failure)}
                </p>
                {failure.error === 'import_failed' && (
                  <div className="space-y-1 text-xs text-foreground">
                    <p>{t('adminImportExport.importIncompleteDetail', { step: t(`adminImportExport.importStep.${failure.step}`, { defaultValue: failure.step || '—' }) })}</p>
                    <p className="text-muted-foreground">
                      {t('adminImportExport.importIncompletePartial', {
                        tasks: failure.partial?.tasksInserted || 0,
                        comments: failure.partial?.commentsInserted || 0,
                        specs: failure.partial?.specsInserted || 0,
                      })}
                    </p>
                    {failure.detail && <p className="text-muted-foreground break-all">{failure.detail}</p>}
                    <p className="text-muted-foreground">{t('adminImportExport.importIncompleteHint')}</p>
                  </div>
                )}
                {failureIssues.length > 0 && (
                  <ul className="space-y-0.5 text-foreground text-xs">
                    {failureIssues.map((issue, i) => <li key={i}>• {issueText(issue)}</li>)}
                  </ul>
                )}
              </>
            )}
          </div>
        )}

        {preview && !busy && (
          <div className="space-y-4">
            <div className="p-3 rounded-md bg-muted text-sm">
              <p className="font-medium text-foreground mb-1">{t('adminImportExport.previewResultTitle')}</p>
              <ul className="space-y-0.5 text-muted-foreground">
                <li>• {t('adminImportExport.previewTotalRows')}{t('adminImportExport.unitRows', { count: preview.stats?.totalRows || 0 })}</li>
                <li>• {t('adminImportExport.resultTasks')}{t('adminImportExport.unitRows', { count: preview.stats?.tasksParsed || 0 })}</li>
                <li>• {t('adminImportExport.resultComments')}{t('adminImportExport.unitRows', { count: preview.stats?.commentsParsed || 0 })}</li>
                <li>• {t('adminImportExport.resultSpecs')}{t('adminImportExport.unitRows', { count: preview.stats?.specsParsed || 0 })}</li>
                <li>• {t('adminImportExport.resultSprints')}{t('adminImportExport.unitSprints', { count: preview.stats?.sprintsParsed || 0 })}</li>
                {(preview.stats?.subtasksLinked || 0) > 0 && (
                  <li>• {t('adminImportExport.resultSubtasks')}{t('adminImportExport.unitRows', { count: preview.stats?.subtasksLinked || 0 })}</li>
                )}
                {(preview.stats?.newProjects?.length ?? 0) > 0 && (
                  <li>• {t('adminImportExport.resultNewProjects')}{preview.stats!.newProjects!.join(', ')}</li>
                )}
              </ul>
              {(preview.stats?.tasksParsed || 0) === 0 && (
                <p className="mt-2 text-xs text-destructive flex items-center gap-1.5">
                  <AlertTriangle size={12} className="flex-shrink-0" />{t('adminImportExport.noTasks')}
                </p>
              )}
              {(preview.stats?.epicChildren || 0) > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">{t('adminImportExport.epicChildrenNote', { count: preview.stats?.epicChildren })}</p>
              )}
              {(preview.stats?.attachmentsParsed || 0) > 0 && (
                <p className="mt-2 text-xs text-muted-foreground">{t('adminImportExport.attachmentsNote', { count: preview.stats?.attachmentsParsed })}</p>
              )}
            </div>

            {(preview.statusMapping?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <p className="text-sm font-medium text-foreground">{t('adminImportExport.statusMappingTitle')}</p>
                <p className="text-xs text-muted-foreground">{t('adminImportExport.statusMappingHint')}</p>
                <div className="overflow-x-auto rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/60 text-muted-foreground">
                      <tr>
                        <th className="text-left font-medium px-2 py-1.5">{t('adminImportExport.statusMappingJira')}</th>
                        <th className="text-left font-medium px-2 py-1.5">{t('adminImportExport.statusMappingLivo')}</th>
                        <th className="text-right font-medium px-2 py-1.5">{t('adminImportExport.statusMappingCount')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.statusMapping!.map((row) => (
                        <tr key={`${row.jiraStatus}|${row.jiraCategory}`} className="border-t">
                          <td className="px-2 py-1.5">
                            {row.jiraStatus || t('adminImportExport.statusMappingEmpty')}
                            {row.jiraCategory && <span className="block text-muted-foreground">{row.jiraCategory}</span>}
                          </td>
                          <td className="px-2 py-1.5">
                            {row.statusName}
                            <span className={`block ${row.substituted ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>
                              {t(`adminImportExport.statusVia.${row.via}`)}
                              {row.substituted && ` · ${t('adminImportExport.statusSubstituted')}`}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right tabular-nums">{row.issueCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="space-y-1">
              <label htmlFor="jira-import-tz" className="text-xs font-medium text-foreground">{t('adminImportExport.timeZoneLabel')}</label>
              <SearchableSelect
                id="jira-import-tz"
                value={timeZone}
                onChange={(e) => setTimeZone(e.target.value)}
                className="block w-full max-w-xs border border-input rounded-md px-2 py-1.5 text-xs bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
              >
                {TIME_ZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
              </SearchableSelect>
              <p className="text-xs text-muted-foreground">{t('adminImportExport.timeZoneHint')}</p>
            </div>

            {people.length > 0 && (
              <div className="space-y-2">
                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <Users size={14} className="text-primary" />
                  {t('adminImportExport.peopleTitle', { count: people.length })}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('adminImportExport.peopleSummary', { existing: counts.existing, login: counts.login, nameOnly: counts.nameOnly })}
                </p>
                <div className="max-h-72 overflow-auto border border-border rounded-md">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="text-left font-medium text-muted-foreground px-3 py-2">{t('adminImportExport.peopleName')}</th>
                        <th className="text-left font-medium text-muted-foreground px-3 py-2">{t('adminImportExport.peopleRoles')}</th>
                        <th className="text-left font-medium text-muted-foreground px-3 py-2">{t('adminImportExport.peoplePlan')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {people.map((p, i) => (
                        <tr key={`${i}-${p.name}`} className="border-t border-border align-top">
                          <td className="px-3 py-2 text-foreground whitespace-nowrap">{p.name}</td>
                          <td className="px-3 py-2 text-muted-foreground">
                            {p.roles.map((r) => t(`adminImportExport.roles.${r}`, { defaultValue: r })).join(t('adminImportExport.listSeparator'))}
                          </td>
                          <td className="px-3 py-2">{planCell(p)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {(preview.unresolvedCommenters || 0) > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('adminImportExport.unresolvedCommenters', { count: preview.unresolvedCommenters })}
                  </p>
                )}
              </div>
            )}

            {people.length > 0 && (
              <div className="space-y-2 p-3 rounded-md border border-border">
                <p className="text-sm font-medium text-foreground flex items-center gap-1.5">
                  <KeyRound size={14} className="text-primary" />
                  {t('adminImportExport.accounts.title')}
                </p>
                <p className="text-xs text-muted-foreground">{t('adminImportExport.accounts.desc')}</p>
                <p className="text-xs text-muted-foreground flex items-start gap-1.5">
                  <Mail size={12} className="flex-shrink-0 mt-0.5" />
                  {preview.loginMethod === 'invite'
                    ? t('adminImportExport.accounts.methodInvite')
                    : t('adminImportExport.accounts.methodTempPassword')}
                </p>
                <textarea
                  value={accountText}
                  onChange={(e) => setAccountText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  placeholder={t('adminImportExport.accounts.placeholder')}
                  className="w-full border border-input rounded-md px-3 py-2 text-xs font-mono bg-background text-foreground outline-none focus:ring-2 focus:ring-ring"
                />
                <input ref={listInputRef} type="file" accept=".csv,.txt,text/csv,text/plain" onChange={handleListFile} className="hidden" />
                <div className="flex flex-wrap items-center gap-2">
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={() => listInputRef.current?.click()}>
                    <Upload size={14} />{t('adminImportExport.accounts.upload')}
                  </Button>
                  <Button size="sm" variant="outline" className="gap-1.5" onClick={downloadTemplate}>
                    <Download size={14} />{t('adminImportExport.accounts.template')}
                  </Button>
                  <Button size="sm" className="gap-1.5" disabled={!csv || !listDirty} onClick={() => csv && runPreview(csv.text, accountText, true)}>
                    {t('adminImportExport.accounts.apply')}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('adminImportExport.accounts.lineCount', { count: parsedList.accounts.length })}
                  </span>
                </div>
                {parsedList.skipped.length > 0 && (
                  <p className="text-xs text-amber-600">
                    {t('adminImportExport.accounts.skippedLines', { lines: parsedList.skipped.map((s) => s.line).join(', ') })}
                  </p>
                )}
                {listDirty && <p className="text-xs text-amber-600">{t('adminImportExport.accounts.notApplied')}</p>}
                {accountErrors.length > 0 && (
                  <div className="text-xs text-destructive space-y-0.5" role="alert">
                    <p className="font-medium">{t('adminImportExport.accountErrorsTitle')}</p>
                    {accountErrors.map((issue, i) => <p key={i}>• {issueText(issue)}</p>)}
                  </div>
                )}
                {accountWarnings.length > 0 && (
                  <div className="text-xs text-amber-600 space-y-0.5">
                    {accountWarnings.map((issue, i) => <p key={i}>• {issueText(issue)}</p>)}
                  </div>
                )}
              </div>
            )}

            {canImport ? (
              <div className="space-y-2">
                <p className="text-xs text-destructive flex items-center gap-1.5">
                  <AlertTriangle size={12} className="flex-shrink-0" />
                  {t('adminImportExport.importWarning')}
                </p>
                <Button
                  onClick={handleImport}
                  disabled={!!busy || listDirty || accountErrors.length > 0 || (preview.stats?.tasksParsed || 0) === 0}
                  variant="destructive"
                  className="gap-2"
                >
                  <Download size={16} />{t('adminImportExport.startImport')}
                </Button>
              </div>
            ) : (
              <UpgradePrompt feature="jira-import" inline />
            )}
          </div>
        )}

        {result && !busy && (
          <div className="p-3 rounded-md bg-muted text-sm space-y-2">
            <div>
              <p className="font-medium text-foreground mb-1">{t('adminImportExport.resultTitle')}</p>
              <ul className="space-y-0.5 text-muted-foreground">
                <li>• {t('adminImportExport.resultTasks')}{t('adminImportExport.unitRows', { count: result.stats?.tasksInserted || 0 })}</li>
                <li>• {t('adminImportExport.resultComments')}{t('adminImportExport.unitRows', { count: result.stats?.commentsInserted || 0 })}</li>
                <li>• {t('adminImportExport.resultSpecs')}{t('adminImportExport.unitRows', { count: result.stats?.specsInserted || 0 })}</li>
                <li>• {t('adminImportExport.resultSprints')}{t('adminImportExport.unitSprints', { count: result.stats?.sprintsCreated || 0 })}</li>
                {(result.stats?.subtasksLinked || 0) > 0 && (
                  <li>• {t('adminImportExport.resultSubtasks')}{t('adminImportExport.unitRows', { count: result.stats?.subtasksLinked || 0 })}</li>
                )}
                {(result.stats?.newMembers?.length ?? 0) > 0 && (
                  <li>• {t('adminImportExport.resultNewMembers')}{result.stats!.newMembers!.join(', ')}</li>
                )}
              </ul>
            </div>
            {(result.stats?.attachmentsParsed || 0) > 0 && (
              <p className="text-xs text-muted-foreground">{t('adminImportExport.attachmentsNote', { count: result.stats?.attachmentsParsed })}</p>
            )}
            {result.accounts && (
              <ul className="space-y-0.5 text-xs text-muted-foreground">
                {result.accounts.invited.length > 0 && (
                  <li>• {t('adminImportExport.accounts.invited', { count: result.accounts.invited.length, emails: result.accounts.invited.map((a) => a.email).join(', ') })}</li>
                )}
                {result.accounts.credentials.length > 0 && (
                  <li>• {t('adminImportExport.accounts.tempIssued', { count: result.accounts.credentials.length })}</li>
                )}
                {result.accounts.failed.map((f) => (
                  <li key={f.email} className="text-destructive">
                    • {t(
                      f.reason === 'email_taken'
                        ? 'adminImportExport.accounts.failedTaken'
                        : f.reason === 'delivery_failed'
                          ? 'adminImportExport.accounts.failedDelivery'
                          : 'adminImportExport.accounts.failedOther',
                      { name: f.name, email: f.email },
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(result.warnings?.length ?? 0) > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
                <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
                {t('adminImportExport.importWarnings', {
                  steps: result.warnings!.map((w) => t(`adminImportExport.importStep.${w}`, { defaultValue: w })).join(t('adminImportExport.listSeparator')),
                })}
              </p>
            )}
          </div>
        )}
      </CardContent>
      {credentials.length > 0 && <AccountCredentialsDialog credentials={credentials} onClose={() => setCredentials([])} />}
      {ConfirmDialog}
    </Card>
  );
};

export default JiraImportCard;
