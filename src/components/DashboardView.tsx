import { BarChart3 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useDashboardData } from './dashboard/useDashboardData';
import DashboardSummary from './dashboard/DashboardSummary';
import DashboardStatusCharts from './dashboard/DashboardStatusCharts';
import DashboardTransitionMatrix from './dashboard/DashboardTransitionMatrix';
import DashboardTeamWorkload from './dashboard/DashboardTeamWorkload';
import DashboardProductLines from './dashboard/DashboardProductLines';
import DashboardProjectProgress from './dashboard/DashboardProjectProgress';
import DashboardSprintHistory from './dashboard/DashboardSprintHistory';

const DashboardView = () => {
  const { t } = useTranslation();
  const {
    totalTasks, overdueTasks,
    statusData, dwellData, transitionData, teamData, lineData, projectProgressData,
    completedSprints, currentSprint,
    statuses, isMobile,
  } = useDashboardData();

  if (totalTasks === 0) {
    return (
      <div className="flex-1 overflow-auto p-3 md:p-6 bg-board flex flex-col items-center justify-center">
        <div className="text-center max-w-sm">
          <BarChart3 size={72} className="mx-auto mb-4 text-slate-400" aria-hidden="true" />
          <h2 className="text-base font-bold text-foreground mb-2">{t('dashboard.noDataTitle')}</h2>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t('dashboard.noDataDesc')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 min-w-0 flex-1 overflow-auto overscroll-contain p-3 md:p-6 bg-board">
      <div className="w-full min-w-0 max-w-[1600px] mx-auto">
        <h1 className="text-base md:text-lg font-bold text-foreground mb-3 md:mb-5">{t('dashboard.title')}</h1>

        <DashboardSummary
          totalTasks={totalTasks}
          overdueTasks={overdueTasks}
          statusData={statusData}
          isMobile={isMobile}
        />

        <DashboardStatusCharts
          statusData={statusData}
          dwellData={dwellData}
          isMobile={isMobile}
        />

        <DashboardTransitionMatrix transitionData={transitionData} />

        <DashboardTeamWorkload
          teamData={teamData}
          statuses={statuses}
          isMobile={isMobile}
        />

        <DashboardProductLines lineData={lineData} />

        <DashboardProjectProgress projectProgressData={projectProgressData} />

        <DashboardSprintHistory
          currentSprint={currentSprint}
          completedSprints={completedSprints}
          isMobile={isMobile}
        />
      </div>
    </div>
  );
};

export default DashboardView;
