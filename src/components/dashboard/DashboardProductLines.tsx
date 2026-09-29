import { useTranslation } from 'react-i18next';

interface LineItem {
  id: string;
  name: string;
  icon?: string;
  total: number;
  done: number;
  active: number;
  pct: number;
}

interface DashboardProductLinesProps {
  lineData: LineItem[];
}

const DashboardProductLines = ({ lineData }: DashboardProductLinesProps) => {
  const { t } = useTranslation();

  return (
    <div className="bg-card rounded-lg border border-border p-3 md:p-4">
      <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{t('dashboard.productLinesTitle')}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2 md:gap-3">
        {lineData.map(line => (
          <div key={line.id} className="bg-muted rounded-lg p-3 md:p-4">
            <div className="flex items-center gap-1.5 mb-2 md:mb-3">
              <span className="text-base md:text-lg">{line.icon}</span>
              <span className="text-[13px] md:text-sm font-semibold text-foreground">{line.name}</span>
            </div>
            <div className="grid grid-cols-3 gap-2 mb-2 md:mb-3 text-center">
              <div>
                <div className="text-base md:text-lg font-bold text-foreground">{line.total}</div>
                <div className="text-[13px] text-muted-foreground">{t('dashboard.totalCount')}</div>
              </div>
              <div>
                <div className="text-base md:text-lg font-bold text-primary">{line.active}</div>
                <div className="text-[13px] text-muted-foreground">{t('dashboard.inProgress')}</div>
              </div>
              <div>
                <div className="text-base md:text-lg font-bold text-emerald-500">{line.done}</div>
                <div className="text-[13px] text-muted-foreground">{t('dashboard.completed')}</div>
              </div>
            </div>
            <div className="w-full bg-border rounded-full h-2 mb-1">
              <div className="h-2 rounded-full transition-all bg-emerald-500" style={{ width: `${line.pct}%` }} />
            </div>
            <div className="text-[13px] font-medium text-right text-emerald-500">{line.pct}%</div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default DashboardProductLines;
