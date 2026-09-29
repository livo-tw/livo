import { format } from 'date-fns';
import { useTranslation } from 'react-i18next';
import { CalendarIcon, Rocket } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import type { TaskDeployment } from '@/types';

const envList = ['Dev', 'QA', 'Stage', 'Live Staging', 'Prod'] as const;
type EnvName = typeof envList[number];

interface TaskFormDeploymentProps {
  deployments: TaskDeployment[];
  setDeployments: (d: TaskDeployment[] | ((prev: TaskDeployment[]) => TaskDeployment[])) => void;
  requiredFields: Record<string, boolean>;
}

const TaskFormDeployment = ({ deployments, setDeployments, requiredFields }: TaskFormDeploymentProps) => {
  const { t } = useTranslation();
  const toggleDeploy = (env: EnvName) => {
    const exists = deployments.find(d => d.environment === env);
    if (exists) {
      setDeployments((prev: TaskDeployment[]) => prev.filter(d => d.environment !== env));
    } else {
      setDeployments((prev: TaskDeployment[]) => [...prev, { environment: env, status: 'scheduled', deployDate: undefined }]);
    }
  };

  return (
    <div>
      <h3 className="text-sm font-semibold text-foreground mb-2 flex items-center gap-1">
        <Rocket size={16} /> {t('taskCreate.deploymentLabel')}{requiredFields.deployments && <span className="text-destructive"> *</span>}
      </h3>
      <div className="space-y-2">
        {envList.map(env => {
          const dep = deployments.find(d => d.environment === env);
          const active = !!dep;
          return (
            <div key={env} className="flex items-center gap-2">
              <button onClick={() => toggleDeploy(env)}
                className={cn("px-2.5 py-1 rounded text-xs font-medium border transition-colors min-w-[80px] text-left",
                  active ? "border-primary bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/50")}>
                {env}
              </button>
              {active && (
                <Popover>
                  <PopoverTrigger asChild>
                    <button className="text-[11px] text-muted-foreground hover:text-foreground flex items-center gap-1 border border-border rounded px-1.5 py-0.5">
                      <CalendarIcon size={10} />
                      {dep?.deployDate || t('taskCreate.scheduled')}
                    </button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar mode="single" selected={dep?.deployDate ? new Date(dep.deployDate) : undefined}
                      onSelect={(date) => { if (date) { setDeployments((prev: TaskDeployment[]) => prev.map(d => d.environment === env ? { ...d, deployDate: format(date, 'yyyy-MM-dd') } : d)); } }}
                      initialFocus className="p-3 pointer-events-auto" />
                  </PopoverContent>
                </Popover>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TaskFormDeployment;
