import { useTranslation } from 'react-i18next';

interface StatusItem {
  name: string;
  count: number;
  color: string;
  pct: number;
}

interface DashboardSummaryProps {
  totalTasks: number;
  overdueTasks: number;
  statusData: StatusItem[];
  isMobile: boolean;
}

const DashboardSummary = ({ totalTasks, overdueTasks, statusData, isMobile }: DashboardSummaryProps) => {
  const { t } = useTranslation();

  return (
    <>
      <div className="grid grid-cols-2 gap-2 md:gap-3 mb-2 md:mb-3">
        <div className="bg-card rounded-lg p-3 md:p-5 border border-border">
          <div className="text-2xl md:text-3xl font-bold text-primary">{totalTasks}</div>
          <div className="text-xs md:text-[13px] text-muted-foreground mt-1">{t('dashboard.totalTasksLabel')}</div>
        </div>
        <div className="bg-card rounded-lg p-3 md:p-5 border border-border">
          <div className="text-2xl md:text-3xl font-bold text-destructive">{overdueTasks}</div>
          <div className="text-xs md:text-[13px] text-muted-foreground mt-1">{t('dashboard.overdueLabel')}</div>
        </div>
      </div>

      <div className="overflow-x-auto mb-4 md:mb-6 scrollbar-hide">
        <div
          className="grid gap-1.5 md:gap-2"
          style={{
            gridTemplateColumns: `repeat(${statusData.length}, minmax(0, 1fr))`,
            minWidth: isMobile ? `${statusData.length * 90}px` : undefined,
          }}
        >
          {statusData.map(s => (
            <div key={s.name} className="bg-card rounded-lg p-2.5 md:p-3 border border-border text-center">
              <div className="text-base md:text-lg font-bold" style={{ color: s.color }}>{s.count}</div>
              <div className="text-[13px] text-muted-foreground leading-tight">{s.name}</div>
              <div className="text-[13px] text-muted-foreground">{s.pct}%</div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
};

export default DashboardSummary;
