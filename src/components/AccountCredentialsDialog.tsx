import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, KeyRound, X } from 'lucide-react';
import { toast } from 'sonner';
import { useConfirmDialog } from '@/components/ConfirmDialog';

// One-time display of temporary passwords for logins an admin just created
// (Jira import, 「啟用帳號」) when email sending is not configured — or when
// an invitation could not be sent. The passwords exist only in this dialog's
// props: once it closes they are gone, so it offers a CSV download and copy.

export interface AccountCredential {
  name: string;
  email: string;
  password: string;
  /** The invitation email failed, so this temporary password replaced it. */
  inviteFailed?: boolean;
}

interface AccountCredentialsDialogProps {
  credentials: AccountCredential[];
  onClose: () => void;
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const AccountCredentialsDialog = ({ credentials, onClose }: AccountCredentialsDialogProps) => {
  const { t } = useTranslation();
  const [saved, setSaved] = useState(false);
  const { confirm, ConfirmDialog } = useConfirmDialog();
  if (credentials.length === 0) return null;

  const rows = credentials.map((c) => [c.name, c.email, c.password]);
  const header = [t('accountCredentials.name'), 'Email', t('accountCredentials.password')];

  const download = () => {
    const csv = '\uFEFF' + [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `livo-logins-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    setSaved(true);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([header, ...rows].map((r) => r.join('\t')).join('\n'));
      toast.success(t('accountCredentials.copied'));
      setSaved(true);
    } catch {
      toast.error(t('accountCredentials.copyFailed'));
    }
  };

  const close = async () => {
    if (!saved && !(await confirm({ description: t('accountCredentials.closeConfirm'), destructive: true }))) return;
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-card rounded-xl shadow-xl border border-border p-5 md:p-6 w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-base font-bold text-foreground flex items-center gap-2">
            <KeyRound size={18} className="text-primary" />
            {t('accountCredentials.title')}
          </h2>
          <button onClick={close} className="text-muted-foreground hover:text-foreground" aria-label={t('common.close')}>
            <X size={18} />
          </button>
        </div>
        <p className="text-xs text-destructive mb-1">{t('accountCredentials.onceWarning')}</p>
        <p className="text-xs text-muted-foreground mb-3">{t('accountCredentials.handOver')}</p>
        <div className="overflow-auto border border-border rounded-md flex-1 min-h-0">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">{header[0]}</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">Email</th>
                <th className="text-left font-medium text-muted-foreground px-3 py-2">{header[2]}</th>
              </tr>
            </thead>
            <tbody>
              {credentials.map((c) => (
                <tr key={c.email} className="border-t border-border">
                  <td className="px-3 py-2 text-foreground whitespace-nowrap">
                    {c.name}
                    {c.inviteFailed && (
                      <span className="block text-[10px] text-amber-600">{t('accountCredentials.inviteFailed')}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground break-all">{c.email}</td>
                  <td className="px-3 py-2 font-mono text-foreground select-all whitespace-nowrap">{c.password}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2 pt-4">
          <button
            onClick={download}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Download size={14} /> {t('accountCredentials.download')}
          </button>
          <button
            onClick={copy}
            className="flex items-center gap-1.5 px-3 py-2 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors"
          >
            <Copy size={14} /> {t('accountCredentials.copy')}
          </button>
          <button
            onClick={close}
            className="ml-auto px-3 py-2 rounded-md text-sm font-medium border border-border text-foreground hover:bg-accent transition-colors"
          >
            {t('accountCredentials.done')}
          </button>
        </div>
      </div>
      {ConfirmDialog}
    </div>
  );
};

export default AccountCredentialsDialog;
