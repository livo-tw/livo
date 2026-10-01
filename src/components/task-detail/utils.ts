import DOMPurify from 'dompurify';
import { supabase } from '@/integrations/supabase/client';
import i18n from '@/i18n';
import { isApprovalEvent } from '@/lib/featureToggles';
import { loadFeatureToggles } from '@/lib/featureToggleQueries';

const ALLOWED_TAGS = ['p', 'br', 'strong', 'em', 'b', 'i', 'u', 's', 'del', 'strike',
  'a', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'code', 'pre',
  'img', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr',
  'sub', 'sup', 'mark'];
const ALLOWED_ATTR = ['href', 'src', 'alt', 'target', 'rel', 'class', 'style',
  'colspan', 'rowspan', 'width', 'height'];

export const fixHtml = (html: string): string => {
  if (!html) return html;
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR });
};

export const createNotification = async (
  recipientId: string,
  senderId: string,
  type: string,
  taskId: string,
  content: string = '',
) => {
  if (recipientId === senderId) return;
  if (isApprovalEvent(type)) {
    try { if (!(await loadFeatureToggles()).approvals) return; }
    catch (error) { console.error('[LIVO] Approval notification skipped:', error); return; }
  }
  const { error } = await supabase.from('notifications').insert({
    recipient_id: recipientId, sender_id: senderId, type, task_id: taskId, content,
  });
  if (error) console.error('[LIVO] 建立通知失敗:', error.message);
};

export const getPriorityOptions = (): { value: string; label: string; icon: string; color: string }[] => [
  { value: 'highest', label: i18n.t('priority.highest'), icon: '●', color: '#FF5630' },
  { value: 'high',    label: i18n.t('priority.high'),    icon: '●', color: '#FF8B00' },
  { value: 'medium',  label: i18n.t('priority.medium'),  icon: '●', color: '#FFAB00' },
  { value: 'low',     label: i18n.t('priority.low'),     icon: '●', color: '#0065FF' },
  { value: 'lowest',  label: i18n.t('priority.lowest'),  icon: '●', color: '#6B778C' },
];


export const envList = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'] as const;
export type EnvName = typeof envList[number];
