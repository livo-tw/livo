import { useProjectColor } from '@/hooks/useProjectColor';
import { useTranslation } from 'react-i18next';

interface ProjectItem {
  id: string;
  name: string;
  key: string;
  color: string;
  total: number;
  done: number;
  inProgress: number;
  pct: number;
}

interface DashboardProjectProgressProps {
  projectProgressData: ProjectItem[];
}

const DashboardProjectProgress = ({ projectProgressData }: DashboardProjectProgressProps) => {
  const getProjectColor = useProjectColor();
  const { t } = useTranslation();

  return (
    <div className="bg-card rounded-lg border border-border p-3 md:p-4 mt-4 md:mt-6">
      <h3 className="text-sm md:text-base font-semibold text-foreground mb-3">{t('dashboard.projectProgressTitle')}</h3>
      {projectProgressData.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2 md:gap-3">
          {projectProgressData.map(project => (
            <div key={project.id} className="bg-muted rounded-lg p-3 md:p-4">
              <div className="flex items-start justify-between gap-2 md:gap-3 mb-2 md:mb-3">
                <div className="min-w-0">
                  <div className="text-[13px] md:text-sm font-semibold text-foreground truncate">{project.name}</div>
                  <div className="text-[13px] text-muted-foreground">{project.key}</div>
                </div>
                <div className="text-[13px] md:text-sm font-bold text-foreground">{project.pct}%</div>
              </div>
              <div className="w-full bg-border rounded-full h-2 mb-2 md:mb-3">
                <div className="h-2 rounded-full transition-all" style={{ width: `${project.pct}%`, backgroundColor: getProjectColor(project) }} />
              </div>
              <div className="grid grid-cols-3 gap-2 text-center">
                <div>
                  <div className="text-[13px] md:text-sm font-semibold text-foreground">{project.total}</div>
                  <div className="text-[13px] text-muted-foreground">{t('dashboard.totalTasks')}</div>
                </div>
                <div>
                  <div className="text-[13px] md:text-sm font-semibold text-foreground">{project.inProgress}</div>
                  <div className="text-[13px] text-muted-foreground">{t('dashboard.inProgress')}</div>
                </div>
                <div>
                  <div className="text-[13px] md:text-sm font-semibold text-foreground">{project.done}</div>
                  <div className="text-[13px] text-muted-foreground">{t('dashboard.completed')}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-center text-muted-foreground text-sm py-6">{t('dashboard.noProjects')}</div>
      )}
    </div>
  );
};

export default DashboardProjectProgress;
