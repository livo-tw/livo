import { useTranslation } from 'react-i18next';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

interface Props {
  target: { id: string; name: string } | null;
  value: string;
  onChange: (value: string) => void;
  existingTitles: string[];
  loading: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (event: React.FormEvent) => void;
}

export default function EditJobTitleModal({ target, value, onChange, existingTitles, loading, error, onClose, onSubmit }: Props) {
  const { t } = useTranslation();
  return <Dialog open={!!target} onOpenChange={open => { if (!open && !loading) onClose(); }}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>{t('memberJobTitle.editMember', { name: target?.name || '' })}</DialogTitle>
        <DialogDescription>{t('memberJobTitle.permissionHint')}</DialogDescription>
      </DialogHeader>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="edit-member-job-title" className="mb-1 block text-sm font-medium">{t('memberList.jobTitleLabel')}</label>
          <input id="edit-member-job-title" value={value} onChange={event => onChange(event.target.value)} list="existing-member-job-titles" maxLength={200} disabled={loading} autoFocus autoComplete="off" placeholder={t('memberList.jobTitlePlaceholder')} className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground focus:ring-2 focus:ring-ring" />
          <datalist id="existing-member-job-titles">{existingTitles.map(title => <option key={title} value={title} />)}</datalist>
          <p className="mt-1 text-xs text-muted-foreground">{t('memberJobTitle.customHint')}</p>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={loading} className="rounded-md border border-border px-3 py-2 text-sm hover:bg-accent disabled:opacity-50">{t('memberList.cancelButton')}</button>
          <button type="submit" disabled={loading} className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50">{loading ? t('memberList.processingButton') : t('memberJobTitle.save')}</button>
        </div>
      </form>
    </DialogContent>
  </Dialog>;
}
