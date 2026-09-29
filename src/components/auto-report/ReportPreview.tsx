import { Eye, BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ReportConfig } from './types';

interface ReportPreviewProps {
  cfg: ReportConfig;
}

const ReportPreview = ({ cfg }: ReportPreviewProps) => {
  const { t } = useTranslation();
  const now = new Date();
  const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const isDaily = cfg.reportType === 'daily';

  const content = (() => {
    if (cfg.templateKey === 'custom' && cfg.customTemplate) {
      const preview = cfg.customTemplate
        .replace('{{date}}', dateStr)
        .replace('{{task_count}}', '12')
        .replace('{{completed_count}}', '5')
        .replace('{{in_progress_count}}', '4')
        .replace('{{overdue_count}}', '3')
        .replace('{{completed_tasks}}', `- [LIVO-42] ${t('autoReport.preview.sampleCompleted1')}\n- [LIVO-38] ${t('autoReport.preview.sampleCompleted2')}\n- [LIVO-51] ${t('autoReport.preview.sampleCompleted3')}\n- [LIVO-45] ${t('autoReport.preview.sampleCompleted4')}\n- [LIVO-33] ${t('autoReport.preview.sampleCompleted5')}`)
        .replace('{{in_progress_tasks}}', `- [LIVO-55] ${t('autoReport.preview.sampleInProgress1')}\n- [LIVO-48] ${t('autoReport.preview.sampleInProgress2')}\n- [LIVO-60] ${t('autoReport.preview.sampleInProgress3')}\n- [LIVO-52] ${t('autoReport.preview.sampleInProgress4')}`)
        .replace('{{overdue_tasks}}', `- [LIVO-30] ${t('autoReport.preview.sampleOverdue1')}\n- [LIVO-25] ${t('autoReport.preview.sampleOverdue2')}\n- [LIVO-28] ${t('autoReport.preview.sampleOverdue3')}`)
        .replace('{{upcoming_deadlines}}', `- [LIVO-55] ${t('autoReport.preview.sampleUpcoming1')}\n- [LIVO-60] ${t('autoReport.preview.sampleUpcoming2')}`)
        .replace('{{all_tasks}}', `- [LIVO-42] ${t('autoReport.preview.sampleCompleted1')} ✓\n- [LIVO-55] ${t('autoReport.preview.sampleInProgress1')} (${t('autoReport.preview.inProgressLabel')})\n- [LIVO-30] ${t('autoReport.preview.sampleOverdueShort1')} (${t('autoReport.preview.overdueLabel')})`);
      return <div className="whitespace-pre-wrap text-sm text-foreground font-mono leading-relaxed">{preview}</div>;
    }

    const sampleCompleted = [
      t('autoReport.preview.sampleCompleted1'),
      t('autoReport.preview.sampleCompleted2'),
      t('autoReport.preview.sampleCompleted3'),
      t('autoReport.preview.sampleCompleted4'),
      t('autoReport.preview.sampleCompleted5'),
    ];
    const sampleInProgress = [
      t('autoReport.preview.sampleInProgress1'),
      t('autoReport.preview.sampleInProgress2'),
      t('autoReport.preview.sampleInProgress3'),
      t('autoReport.preview.sampleInProgress4'),
    ];

    return (
      <div className="space-y-4 text-sm">
        <div className="font-semibold text-foreground flex items-center gap-2">
          <BarChart3 size={18} className="text-blue-500 flex-shrink-0" />
          <span>{isDaily ? t('autoReport.preview.dailyTitle', { date: dateStr }) : t('autoReport.preview.weeklyTitle', { date: dateStr })}</span>
        </div>
        <div>
          <div className="font-medium text-green-600 mb-1">{isDaily ? t('autoReport.preview.todayCompleted') : t('autoReport.preview.weekCompleted')}{t('autoReport.preview.countSuffix', { count: 5 })}</div>
          <div className="text-muted-foreground pl-3 space-y-0.5">
            {sampleCompleted.map((task, i) => (
              <div key={i}>• [LIVO-{42 - i}] {task}</div>
            ))}
          </div>
        </div>
        <div>
          <div className="font-medium text-blue-500 mb-1">{t('autoReport.preview.inProgressLabel')}{t('autoReport.preview.countSuffix', { count: 4 })}</div>
          <div className="text-muted-foreground pl-3 space-y-0.5">
            {sampleInProgress.map((task, i) => (
              <div key={i}>• [LIVO-{55 + i * 5}] {task}</div>
            ))}
          </div>
        </div>
        {isDaily ? (
          <div>
            <div className="font-medium text-amber-500 mb-1">{t('autoReport.preview.upcomingLabel')}{t('autoReport.preview.countSuffix', { count: 2 })}</div>
            <div className="text-muted-foreground pl-3 space-y-0.5">
              <div>• [LIVO-55] {t('autoReport.preview.sampleUpcoming1')}</div>
              <div>• [LIVO-60] {t('autoReport.preview.sampleUpcoming2')}</div>
            </div>
          </div>
        ) : (
          <>
            <div>
              <div className="font-medium text-red-500 mb-1">{t('autoReport.preview.overdueLabel')}{t('autoReport.preview.countSuffix', { count: 3 })}</div>
              <div className="text-muted-foreground pl-3 space-y-0.5">
                <div>• [LIVO-30] {t('autoReport.preview.sampleOverdue1')}</div>
                <div>• [LIVO-25] {t('autoReport.preview.sampleOverdue2')}</div>
                <div>• [LIVO-28] {t('autoReport.preview.sampleOverdue3')}</div>
              </div>
            </div>
            <div>
              <div className="font-medium text-foreground mb-1">{t('autoReport.preview.nextWeekFocus')}</div>
              <div className="text-muted-foreground pl-3 space-y-0.5">
                <div>• [LIVO-55] {t('autoReport.preview.sampleInProgress1')}</div>
                <div>• [LIVO-60] {t('autoReport.preview.sampleInProgress3')}</div>
              </div>
            </div>
          </>
        )}
        <div className="text-xs text-muted-foreground border-t border-border pt-2 mt-2">
          {t('autoReport.preview.summary', { total: 12, completed: 5, inProgress: 4, overdue: 3 })}
        </div>
      </div>
    );
  })();

  return (
    <div className="mt-4 border border-border rounded-xl bg-muted/30 overflow-hidden">
      <div className="px-4 py-2.5 bg-muted/50 border-b border-border flex items-center gap-2">
        <Eye size={14} className="text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">{t('autoReport.previewHeader')}</span>
      </div>
      <div className="p-4">{content}</div>
    </div>
  );
};

export default ReportPreview;
