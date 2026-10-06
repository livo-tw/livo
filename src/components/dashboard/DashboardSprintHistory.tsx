import { Trophy, Zap } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatDate } from './useDashboardData';

interface Sprint {
  id: string;
  name: string;
  isActive: boolean;
  startedAt: string | null;
  completedAt: string | null;
  completedCount: number;
  pendingCount: number;
}

interface DashboardSprintHistoryProps {
  currentSprint: Sprint | null;
  completedSprints: Sprint[];
  isMobile: boolean;
}

const DashboardSprintHistory = ({ currentSprint, completedSprints, isMobile }: DashboardSprintHistoryProps) => {
  const { t } = useTranslation();

  return (
    <div className="bg-card rounded-lg border border-border p-3 md:p-4 mt-4 md:mt-6">
      <div className="flex items-center gap-2 mb-3">
        <Trophy size={18} className="text-primary" />
        <h3 className="text-sm md:text-base font-semibold text-foreground">{t('dashboard.sprintHistoryTitle')}</h3>
      </div>

      {currentSprint && (
        <div className="mb-4 p-3 rounded-lg border border-primary/20 bg-primary/5">
          <div className="flex flex-wrap items-center gap-2 mb-1">
            <Zap size={14} className="text-primary" />
            <span className="text-[13px] font-semibold text-foreground">{currentSprint.name}</span>
            <span className="text-[13px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary font-medium">{t('dashboard.inProgress')}</span>
          </div>
          <div className="text-[13px] text-muted-foreground">{t('dashboard.startedOn', { date: formatDate(currentSprint.startedAt) })}</div>
        </div>
      )}

      {completedSprints.length > 0 ? (
        isMobile ? (
          <div className="space-y-2">
            {completedSprints.map(sprint => {
              const total = sprint.completedCount + sprint.pendingCount;
              const rate = total > 0 ? Math.round((sprint.completedCount / total) * 100) : 0;
              return (
                <div key={sprint.id} className="bg-muted rounded-lg p-3">
                  <div className="font-medium text-[13px] text-foreground mb-1">{sprint.name}</div>
                  <div className="text-[13px] text-muted-foreground mb-2">
                    {formatDate(sprint.startedAt)} → {formatDate(sprint.completedAt)}
                  </div>
                  <div className="flex flex-wrap items-center gap-3 text-[13px]">
                    <span>{t('dashboard.completedCount', { count: sprint.completedCount })}</span>
                    <span>{t('dashboard.pendingCount', { count: sprint.pendingCount })}</span>
                    <div className="flex items-center gap-1 ml-auto">
                      <div className="w-12 bg-background rounded-full h-2.5">
                        <div className="h-full rounded-full" style={{ width: `${rate}%`, backgroundColor: rate >= 70 ? '#36B37E' : rate >= 40 ? '#FF8B00' : '#FF5630' }} />
                      </div>
                      <span className="text-[13px] font-medium" style={{ color: rate >= 70 ? '#36B37E' : rate >= 40 ? '#FF8B00' : '#FF5630' }}>{rate}%</span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-muted/50">
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.sprintNameHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.startTimeHeader')}</th>
                  <th className="text-left text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.endTimeHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.completedHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.pendingHeader')}</th>
                  <th className="text-center text-xs font-medium text-muted-foreground px-4 py-2">{t('dashboard.completionRateHeader')}</th>
                </tr>
              </thead>
              <tbody>
                {completedSprints.map(sprint => {
                  const total = sprint.completedCount + sprint.pendingCount;
                  const rate = total > 0 ? Math.round((sprint.completedCount / total) * 100) : 0;
                  return (
                    <tr key={sprint.id} className="border-t border-border hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-2 font-medium text-foreground">{sprint.name}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(sprint.startedAt)}</td>
                      <td className="px-4 py-2 text-xs text-muted-foreground">{formatDate(sprint.completedAt)}</td>
                      <td className="px-4 py-2 text-center"><span className="font-medium text-emerald-500">{sprint.completedCount}</span></td>
                      <td className="px-4 py-2 text-center"><span className={`font-medium ${sprint.pendingCount > 0 ? 'text-amber-500' : 'text-emerald-500'}`}>{sprint.pendingCount}</span></td>
                      <td className="px-4 py-2 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <div className="w-16 bg-muted rounded-full h-2">
                            <div className="h-full rounded-full" style={{ width: `${rate}%`, backgroundColor: rate >= 70 ? '#36B37E' : rate >= 40 ? '#FF8B00' : '#FF5630' }} />
                          </div>
                          <span className="text-xs font-medium" style={{ color: rate >= 70 ? '#36B37E' : rate >= 40 ? '#FF8B00' : '#FF5630' }}>{rate}%</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="text-center text-muted-foreground text-sm py-6">{t('dashboard.noSprintHistory')}</div>
      )}
    </div>
  );
};

export default DashboardSprintHistory;
