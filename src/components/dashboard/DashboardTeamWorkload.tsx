import { AlertTriangle, CheckCircle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getDwellColor, getLoadColor, getEffColor } from './useDashboardData';

interface StatusNode { id: string; name: string; color: string; }

interface TeamMember {
  id: string;
  name: string;
  avatar: string;
  color: string;
  jobTitle?: string;
  byStatus: { status: StatusNode; count: number }[];
  inProgress: number;
  loadPct: number;
  overdue: number;
  total: number;
  avgCreateToComplete: number | null;
  avgStartToComplete: number | null;
}

interface DashboardTeamWorkloadProps {
  teamData: TeamMember[];
  statuses: StatusNode[];
  isMobile: boolean;
}

const DashboardTeamWorkload = ({ teamData, statuses, isMobile }: DashboardTeamWorkloadProps) => {
  const { t } = useTranslation();

  return (
    <div className="bg-card rounded-lg border border-border p-3 md:p-4 mb-4 md:mb-6">
      <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{t('dashboard.teamWorkloadTitle')}</h3>
      {isMobile ? (
        <div className="space-y-3">
          {teamData.map(member => (
            <div key={member.id} className="bg-muted rounded-lg p-3">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-[9px] font-bold shrink-0" style={{ backgroundColor: member.color, color: '#fff' }}>{member.avatar}</div>
                <div>
                  <div className="text-[13px] font-semibold text-foreground">{member.name}</div>
                  <div className="text-[13px] text-muted-foreground">{member.jobTitle}</div>
                </div>
                {member.overdue > 0 && (
                  <span className="ml-auto inline-flex items-center gap-0.5 text-destructive font-medium text-[13px]">
                    <AlertTriangle className="w-3.5 h-3.5" />{member.overdue}
                  </span>
                )}
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {member.byStatus.filter(bs => bs.count > 0).map(bs => (
                  <span key={bs.status.id} className="text-[13px] font-medium px-1.5 py-0.5 rounded-full" style={{ backgroundColor: bs.status.color + '2E', color: bs.status.color }}>
                    {bs.status.name} {bs.count}
                  </span>
                ))}
              </div>
              <div className="flex items-center gap-1.5 mb-1">
                <span className="text-[13px] text-muted-foreground w-8">{t('dashboard.workloadLabel')}</span>
                <div className="flex-1 bg-background rounded-full h-2.5">
                  <div className="h-full rounded-full transition-all" style={{ width: `${member.loadPct}%`, backgroundColor: getLoadColor(member.inProgress) }} />
                </div>
                <span className="text-[13px]" style={{ color: getLoadColor(member.inProgress) }}>{member.inProgress}</span>
              </div>
              <div className="flex gap-3 text-[13px]">
                <span>{t('dashboard.createdToCompletedLabel')}{member.avgCreateToComplete !== null ? <span style={{ color: getEffColor(member.avgCreateToComplete, 'create') }}>{t('dashboard.dwellDays', { days: member.avgCreateToComplete })}</span> : '-'}</span>
                <span>{t('dashboard.startedToCompletedLabel')}{member.avgStartToComplete !== null ? <span style={{ color: getEffColor(member.avgStartToComplete, 'start') }}>{t('dashboard.dwellDays', { days: member.avgStartToComplete })}</span> : '-'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[900px]">
            <thead>
              <tr className="border-b border-border">
                <th className="text-left py-2 text-muted-foreground font-medium sticky left-0 bg-card z-10">{t('dashboard.memberHeader')}</th>
                <th className="text-left py-2 text-muted-foreground font-medium">{t('dashboard.roleHeader')}</th>
                {statuses.map(s => (<th key={s.id} className="text-center py-2 font-medium" style={{ color: s.color }}>{s.name}</th>))}
                <th className="text-center py-2 text-muted-foreground font-medium">{t('dashboard.workloadBarHeader')}</th>
                <th className="text-center py-2 text-muted-foreground font-medium">{t('dashboard.overdueHeader')}</th>
                <th className="text-center py-2 text-muted-foreground font-medium whitespace-nowrap">{t('dashboard.createdToCompletedHeader')}</th>
                <th className="text-center py-2 text-muted-foreground font-medium whitespace-nowrap">{t('dashboard.startedToCompletedHeader')}</th>
              </tr>
            </thead>
            <tbody>
              {teamData.map(member => (
                <tr key={member.id} className="border-b border-border hover:bg-muted/40 transition-colors">
                  <td className="py-2 sticky left-0 bg-card z-10">
                    <div className="flex items-center gap-1.5">
                      <div className="w-6 h-6 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0" style={{ backgroundColor: member.color, color: '#fff' }}>{member.avatar}</div>
                      <span className="text-foreground whitespace-nowrap">{member.name}</span>
                    </div>
                  </td>
                  <td className="py-2 text-muted-foreground">{member.jobTitle}</td>
                  {member.byStatus.map(bs => (
                    <td key={bs.status.id} className="text-center py-2">
                      {bs.count > 0 ? (
                        <span className="inline-block px-1.5 py-0.5 rounded-full text-xs font-medium" style={{ backgroundColor: bs.status.color + '2E', color: bs.status.color }}>{bs.count}</span>
                      ) : (<span className="text-muted-foreground/40">-</span>)}
                    </td>
                  ))}
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1.5">
                      <div className="flex-1 bg-muted rounded-full h-2 min-w-[60px]">
                        <div className="h-full rounded-full transition-all" style={{ width: `${member.loadPct}%`, backgroundColor: getLoadColor(member.inProgress) }} />
                      </div>
                      <span className="text-xs" style={{ color: getLoadColor(member.inProgress) }}>{member.inProgress}</span>
                    </div>
                  </td>
                  <td className="text-center py-2">
                    {member.overdue > 0 ? (
                      <span className="inline-flex items-center gap-0.5 text-destructive font-medium"><AlertTriangle className="w-3 h-3" />{member.overdue}</span>
                    ) : (<span className="inline-flex items-center gap-0.5 text-emerald-500"><CheckCircle className="w-3 h-3" /></span>)}
                  </td>
                  <td className="text-center py-2">
                    {member.avgCreateToComplete !== null ? (<span className="font-medium" style={{ color: getEffColor(member.avgCreateToComplete, 'create') }}>{t('dashboard.dwellDays', { days: member.avgCreateToComplete })}</span>) : (<span className="text-muted-foreground/40">-</span>)}
                  </td>
                  <td className="text-center py-2">
                    {member.avgStartToComplete !== null ? (<span className="font-medium" style={{ color: getEffColor(member.avgStartToComplete, 'start') }}>{t('dashboard.dwellDays', { days: member.avgStartToComplete })}</span>) : (<span className="text-muted-foreground/40">-</span>)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default DashboardTeamWorkload;
