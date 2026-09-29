import { getDwellColor } from './useDashboardData';

interface StatusNode { id: string; name: string; color: string; }
interface TransitionItem { from: StatusNode; to: StatusNode; avg: number; count: number; }

interface DashboardTransitionMatrixProps {
  transitionData: TransitionItem[];
}

const DashboardTransitionMatrix = ({ transitionData }: DashboardTransitionMatrixProps) => (
  <div className="bg-card rounded-lg border border-border p-3 md:p-4 mb-4 md:mb-6">
    <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">狀態流轉平均時間</h3>
    <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-2 md:gap-3">
      {transitionData.map((t, i) => (
        <div key={i} className="bg-muted rounded-lg p-2.5 md:p-3">
          <div className="flex items-center gap-1 mb-1.5 md:mb-2 flex-wrap">
            <span className="inline-block px-1.5 py-0.5 rounded text-[13px] font-medium text-white" style={{ backgroundColor: t.from.color }}>{t.from.name}</span>
            <span className="text-muted-foreground text-[13px]">→</span>
            <span className="inline-block px-1.5 py-0.5 rounded text-[13px] font-medium text-white" style={{ backgroundColor: t.to.color }}>{t.to.name}</span>
          </div>
          <div className="text-lg md:text-xl font-bold" style={{ color: getDwellColor(t.avg) }}>
            {t.avg}<span className="text-xs font-normal ml-0.5">天</span>
          </div>
          <div className="text-[13px] text-muted-foreground">N={t.count} 筆</div>
        </div>
      ))}
      {transitionData.length === 0 && (
        <div className="col-span-full text-center text-muted-foreground text-sm py-6">暫無狀態流轉記錄</div>
      )}
    </div>
  </div>
);

export default DashboardTransitionMatrix;
