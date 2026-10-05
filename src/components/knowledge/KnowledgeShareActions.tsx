import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Download, Link, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { IconAction } from '@/components/ui/icon-action';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { copyText } from '@/lib/clipboard';
import { knowledgePageText, knowledgePageUrl, knowledgePrintHtml, printKnowledgePage } from '@/lib/knowledgeSharing';
import { knowledgeClient } from '@/integrations/supabase/knowledgeClient';
import type { KnowledgePage } from '@/types/knowledge';

export default function KnowledgeShareActions({ page, scope, disabled = false, onUnavailable }: { page: KnowledgePage; scope: string; disabled?: boolean; onUnavailable: () => void }) {
  const { t } = useTranslation();
  const [working, setWorking] = useState(false);
  async function execute(action: 'link' | 'text' | 'pdf') {
    if (working || disabled) return;
    setWorking(true);
    try {
      // RLS/Worker authorization is checked live; do not export a revoked cached body.
      const result = await knowledgeClient.from('kb_pages').select('id,title,body,updated_at').eq('id', page.id).maybeSingle();
      if (result.error || !result.data) { onUnavailable(); throw new Error('unavailable'); }
      const fresh = result.data as Pick<KnowledgePage, 'id' | 'title' | 'body' | 'updated_at'>;
      if (action === 'pdf') {
        await printKnowledgePage(knowledgePrintHtml(fresh, { scope, updated: t('kb.sharing.updated', { date: new Date(fresh.updated_at).toLocaleString() }), copyNotice: t('kb.sharing.copyNotice') }));
        toast.success(t('kb.sharing.pdfReady'));
      } else {
        const text = action === 'link' ? knowledgePageUrl(fresh.id) : knowledgePageText(fresh.title, fresh.body);
        if (!await copyText(text)) throw new Error('clipboard');
        toast.success(t(action === 'link' ? 'kb.sharing.linkCopied' : 'kb.sharing.contentCopied'));
      }
    } catch (error) {
      toast.error(t(error instanceof Error && error.message === 'unavailable' ? 'kb.sharing.unavailable' : 'kb.sharing.failed'));
    } finally { setWorking(false); }
  }
  return <>
    <IconAction label={t('kb.sharing.copyLink')} disabled={disabled || working} onClick={() => void execute('link')}>{working ? <Loader2 size={16} className="animate-spin" /> : <Link size={16} />}</IconAction>
    <DropdownMenu>
      <DropdownMenuTrigger asChild><IconAction label={t('kb.sharing.export')} disabled={disabled || working}><Download size={16} /></IconAction></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-[calc(100vw-32px)]">
        <DropdownMenuItem onSelect={() => void execute('text')}><Copy size={15} />{t('kb.sharing.copyContent')}</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void execute('pdf')}><Download size={15} />{t('kb.sharing.exportPdf')}</DropdownMenuItem>
        <p className="max-w-64 border-t px-2 pt-2 text-xs leading-5 text-muted-foreground">{t('kb.sharing.accessHint')}</p>
        <p className="max-w-64 px-2 py-2 text-xs leading-5 text-muted-foreground">{t('kb.sharing.copyNotice')}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}
