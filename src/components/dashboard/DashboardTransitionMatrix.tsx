import { useTranslation } from 'react-i18next';
import { getDwellColor } from './useDashboardData';

interface StatusNode { id: string; name: string; color: string; }
interface TransitionItem { from: StatusNode; to: StatusNode; avg: number; count: number; }

interface DashboardTransitionMatrixProps {
  transitionData: TransitionItem[];
}

const DashboardTransitionMatrix = ({ transitionData }: DashboardTransitionMatrixProps) => {
  const { t: tr } = useTranslation();
  return (
  <div className="bg-card rounded-lg border border-border p-3 md:p-4 mb-4 md:mb-6">
    <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{tr('dashboard.transitionMatrixTitle')}</h3>
    <div className="grid grid-cols-1 min-[375px]:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-3">
      {transitionData.map((t, i) => (
        <div key={i} className="min-w-0 break-words bg-muted rounded-lg p-2.5 md:p-3 [overflow-wrap:anywhere]">
          <div className="flex items-center gap-1 mb-1.5 md:mb-2 flex-wrap">
            <span className="inline-block px-1.5 py-0.5 rounded text-[13px] font-medium text-white" style={{ backgroundColor: t.from.color }}>{t.from.name}</span>
            <span className="text-muted-foreground text-[13px]">→</span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[13px] font-medium text-white" style={{ backgroundColor: t.to.color }}>{t.to.name}</span>
          </div>
          <div className="text-lg md:text-xl font-bold" style={{ color: getDwellColor(t.avg) }}>
            {tr('dashboard.dwellDays', { days: t.avg })}
          </div>
          <div className="text-[13px] text-muted-foreground">{tr('dashboard.recordsCount', { count: t.count })}</div>
        </div>
      ))}
      {transitionData.length === 0 && (
        <div className="col-span-full text-center text-muted-foreground text-sm py-6">{tr('dashboard.noTransitionRecords')}</div>
      )}
    </div>
  </div>
  );
};

export default DashboardTransitionMatrix;
