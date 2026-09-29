import { format, parseISO } from 'date-fns';
import { Clock } from 'lucide-react';
import { WorkReport, ReportType, getTabLabels } from './types';
import { useTranslation } from 'react-i18next';

interface WorkReportHistoryProps {
  reportType: ReportType;
  history: WorkReport[];
  onSelect: (report: WorkReport) => void;
}

const WorkReportHistory = ({ reportType, history, onSelect }: WorkReportHistoryProps) => {
  const { t } = useTranslation();
  const tabLabels = getTabLabels();
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-border">
        <h3 className="text-sm font-semibold text-foreground">
          {t('workReport.historyTitle', { type: tabLabels[reportType] })}
        </h3>
      </div>
      <div className="divide-y divide-border max-h-80 overflow-y-auto">
        {history.length === 0 ? (
          <div className="px-4 py-6 text-center text-sm text-muted-foreground">{t('workReport.noHistory')}</div>
        ) : (
          history.map(r => (
            <button
              key={r.id}
              onClick={() => onSelect(r)}
              className="w-full text-left px-4 py-3 hover:bg-accent transition-colors"
            >
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-foreground">{r.title}</span>
                {r.isEdited && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                    {t('workReport.editedBadge')}
                  </span>
                )}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                <Clock size={10} />
                {format(parseISO(r.updatedAt), 'yyyy/MM/dd HH:mm')}
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
};

export default WorkReportHistory;
