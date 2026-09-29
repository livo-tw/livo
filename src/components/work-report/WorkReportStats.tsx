import { CheckCircle2, BarChart3, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface WorkReportStatsProps {
  completedCount: number;
  inProgressCount: number;
  overdueCount: number;
}

const WorkReportStats = ({ completedCount, inProgressCount, overdueCount }: WorkReportStatsProps) => {
  const { t } = useTranslation();
  const stats = [
    { label: t('workReport.stats.completed'), value: completedCount, icon: CheckCircle2, color: 'text-green-500' },
    { label: t('workReport.stats.inProgress'), value: inProgressCount, icon: BarChart3, color: 'text-blue-500' },
    { label: t('workReport.stats.overdue'), value: overdueCount, icon: AlertTriangle, color: 'text-red-500' },
  ];

  return (
    <div className="grid grid-cols-3 gap-3">
      {stats.map(stat => (
        <div key={stat.label} className="bg-card border border-border rounded-xl p-4 flex items-center gap-3">
          <stat.icon size={20} className={stat.color} />
          <div>
            <div className="text-xl font-bold text-foreground">{stat.value}</div>
            <div className="text-xs text-muted-foreground">{stat.label}</div>
          </div>
        </div>
      ))}
    </div>
  );
};

export default WorkReportStats;
