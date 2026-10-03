import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { renderKnowledgeHtml } from '@/lib/knowledgeHtml';

// The app does not install Tailwind Typography. Keep rich content readable with
// explicit selectors; inline source emphasis still takes precedence.
export const KNOWLEDGE_READING_STYLE = [
  'max-w-none break-words text-sm md:text-base leading-7',
  '[&_h1]:mt-8 [&_h1]:mb-4 [&_h1]:text-2xl [&_h1]:font-bold [&_h1]:leading-tight [&_h1]:text-blue-700 dark:[&_h1]:text-blue-300',
  '[&_h2]:mt-7 [&_h2]:mb-3 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:leading-snug [&_h2]:text-blue-700 dark:[&_h2]:text-blue-300',
  '[&_h3]:mt-6 [&_h3]:mb-2 [&_h3]:text-lg [&_h3]:font-semibold [&_h3]:leading-snug',
  '[&_h4]:mt-5 [&_h4]:mb-2 [&_h4]:font-semibold [&_h5]:mt-4 [&_h5]:mb-2 [&_h5]:font-semibold [&_h6]:mt-4 [&_h6]:mb-2 [&_h6]:font-semibold',
  '[&_p]:my-3 [&_p]:leading-7 [&_ul]:my-4 [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:my-4 [&_ol]:list-decimal [&_ol]:pl-6 [&_li]:my-1 [&_li]:pl-1 [&_li>ul]:my-2 [&_li>ol]:my-2',
  '[&_strong]:font-semibold [&_a]:text-blue-700 dark:[&_a]:text-blue-300 [&_a]:underline [&_a]:underline-offset-2',
  '[&_blockquote]:my-4 [&_blockquote]:border-l-4 [&_blockquote]:border-blue-200 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground',
  '[&_img]:my-4 [&_img]:max-w-full [&_img]:h-auto [&_hr]:my-6 [&_hr]:border-border',
  '[&_table]:my-5 [&_table]:block [&_table]:w-full [&_table]:overflow-x-auto [&_table]:border-collapse [&_table]:text-sm',
  '[&_th]:border [&_th]:border-border [&_th]:bg-muted/50 [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_th]:align-top',
  '[&_td]:border [&_td]:border-border [&_td]:px-3 [&_td]:py-2 [&_td]:align-top',
  '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:bg-muted [&_pre]:p-4 [&_pre]:text-sm [&_code]:break-words',
  '[&>:first-child]:mt-0 [&>:last-child]:mb-0',
].join(' ');

/** A presentation-only split: source snapshots and stored HTML remain unchanged. */
export function splitMeetingBody(html: string): { overview: string; source: string | null } {
  const document = new DOMParser().parseFromString(renderKnowledgeHtml(html), 'text/html');
  const heading = Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6')).find(element => /^(完整會議紀錄|完整會議記錄|原始會議紀錄|來源原文|完整会议记录|Full meeting (record|minutes)|Original meeting record|Source record)$/i.test(element.textContent?.trim() || ''));
  if (!heading) return { overview: document.body.innerHTML, source: null };
  const source = document.createElement('div');
  const range = document.createRange();
  range.setStartAfter(heading); range.setEndAfter(document.body.lastChild!);
  source.appendChild(range.extractContents());
  heading.remove();
  return { overview: document.body.innerHTML, source: source.innerHTML };
}

export default function KnowledgeReadingBody({ body, meeting }: { body: string; meeting: boolean }) {
  const { t } = useTranslation();
  const content = useMemo(() => meeting ? splitMeetingBody(body) : { overview: renderKnowledgeHtml(body), source: null }, [body, meeting]);
  return <article className="min-h-40 rounded-xl border bg-card p-5 md:p-7 shadow-sm space-y-6">
    {meeting && !content.source && /\[(?: |x)\]/i.test(body) && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100">{t('kb.navigation.historicalListHint', { defaultValue: 'Text check marks belong to the historical record. Use Tracking to create or link current work.' })}</p>}
    <div className={KNOWLEDGE_READING_STYLE} dangerouslySetInnerHTML={{ __html: content.overview }} />
    {content.source && <details className="rounded-lg border p-4">
      <summary className="cursor-pointer font-medium">{t('kb.navigation.sourceRecord', { defaultValue: 'Original meeting record' })}</summary>
      <p className="text-xs text-muted-foreground my-3">{t('kb.navigation.sourceHint', { defaultValue: 'Historical source snapshot. Its check marks do not update current work.' })}</p>
      <div className={KNOWLEDGE_READING_STYLE} dangerouslySetInnerHTML={{ __html: content.source }} />
    </details>}
  </article>;
}
