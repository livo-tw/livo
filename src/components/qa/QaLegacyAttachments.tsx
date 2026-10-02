import { ExternalLink, Paperclip } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { QaIssue } from '@/lib/qa/domain';

export default function QaLegacyAttachments({ issue }: { issue: QaIssue }) {
  const { t } = useTranslation();
  const source = (issue as unknown as { legacySource?: { recordUrl?: string; attachments?: Array<{ name?: string }> } }).legacySource;
  if (!source || !Array.isArray(source.attachments) || !source.attachments.length || typeof source.recordUrl !== 'string' || !/^https:\/\/[^/]+\.slack\.com\//i.test(source.recordUrl)) return null;
  const attachments = source.attachments.filter(file => file && typeof file.name === 'string');
  if (!attachments.length) return null;
  return <details className="mt-4 rounded-lg border border-border/70 bg-muted/20 p-3">
    <summary className="cursor-pointer text-sm font-medium">{t('qa.sourceAttachments')} · {attachments.length}</summary>
    <ul className="mt-3 space-y-2">{attachments.map((file, index) => <li key={index}><a href={source.recordUrl} target="_blank" rel="noopener noreferrer" className="flex min-w-0 items-center gap-2 rounded px-2 py-1 text-sm text-primary hover:bg-primary/5"><Paperclip size={14} className="shrink-0" aria-hidden="true" /><span className="min-w-0 truncate">{file.name}</span><ExternalLink size={12} className="shrink-0" aria-hidden="true" /></a></li>)}</ul>
  </details>;
}
