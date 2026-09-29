import { Rocket, Clock, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { envList } from './utils';
import type { TaskDetailState } from './hooks/useTaskDetail';

type Props = { detail: TaskDetailState };

const ENV_COLORS: Record<string, string> = {
  'Dev': '#36B37E', 'QA': '#00B8D9', 'Stage': '#FF8B00', 'Live Staging': '#6554C0', 'Prod': '#FF5630',
};

const TaskDeploymentSection = ({ detail }: Props) => {
  const { t } = useTranslation();
  const { task, updateTask, setDeploy, removeDeploy, toggleDeployStatus } = detail;
  if (!task) return null;

  return (
    <div>
      <label className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{t('taskDetail.deployment.title')}</label>
      <div className="mt-1.5 space-y-1.5">
        {envList.map(env => {
          const dep = task.deployments.find(d => d.environment === env);
          if (!dep) {
            return (
              <div key={env} className="border border-dashed border-border rounded p-2 bg-muted/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">{env}</span>
                  <div className="flex gap-1">
                    <button onClick={() => setDeploy(env, 'deployed')} className="text-[11px] px-1.5 py-1 rounded bg-status-done/15 text-status-done hover:bg-status-done/25 min-w-[28px] min-h-[28px] flex items-center justify-center"><Rocket size={12} /></button>
                    <button onClick={() => setDeploy(env, 'scheduled')} className="text-[11px] px-1.5 py-1 rounded bg-status-review/15 text-status-review hover:bg-status-review/25 min-w-[28px] min-h-[28px] flex items-center justify-center"><Clock size={12} /></button>
                  </div>
                </div>
              </div>
            );
          }
          const isDeployed = dep.status === 'deployed';
          const ec = ENV_COLORS[env] || '#36B37E';
          return (
            <div key={env} className={`rounded p-2 ${isDeployed ? '' : 'bg-yellow-50 dark:bg-yellow-900/20'}`} style={{ border: `1px ${isDeployed ? 'solid' : 'dashed'} ${ec}40`, ...(isDeployed ? { backgroundColor: `${ec}12` } : {}) }}>
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1">
                  <button onClick={() => toggleDeployStatus(env)} className="text-xs flex items-center" title={isDeployed ? t('taskDetail.deployment.changeToScheduled') : t('taskDetail.deployment.markAsDeployed')}>
                    {isDeployed ? <Rocket size={12} className="text-status-done" /> : <Clock size={12} className="text-status-review" />}
                  </button>
                  <span className="text-xs font-medium text-foreground">{env}</span>
                  <span className={`text-[11px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${isDeployed ? 'bg-status-done/20 text-status-done' : 'bg-status-review/20 text-status-review'}`}>
                    {isDeployed ? <><Rocket size={10} /> {t('taskDetail.deployment.deployed')}</> : <>{t('taskDetail.deployment.scheduledStatus')}</>}
                  </span>
                </div>
                <button onClick={() => removeDeploy(env)} className="text-muted-foreground hover:text-destructive"><X size={10} /></button>
              </div>
              <div className="flex items-center gap-1 mt-1">
                <span className="text-xs text-muted-foreground">{isDeployed ? t('taskDetail.deployment.dateLabel') : t('taskDetail.deployment.scheduledDateLabel')}</span>
                <input type="date" value={dep.deployDate || ''} onChange={e => {
                  const others = task.deployments.filter(d => d.environment !== env);
                  updateTask({ deployments: [...others, { ...dep, deployDate: e.target.value || undefined }] });
                }} className="text-xs border border-input rounded px-1 py-0.5 bg-background text-foreground focus:outline-none focus:ring-1 focus:ring-ring" />
              </div>
              {!isDeployed ? (
                <button onClick={() => toggleDeployStatus(env)}
                  className="w-full mt-1.5 flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors border-2 border-dashed hover:border-solid"
                  style={{ borderColor: ec, color: ec, backgroundColor: `${ec}08` }}
                  onMouseEnter={e => { (e.target as HTMLElement).style.backgroundColor = `${ec}20`; }}
                  onMouseLeave={e => { (e.target as HTMLElement).style.backgroundColor = `${ec}08`; }}>
                  <Rocket size={14} className="mr-1" /> {t('taskDetail.deployment.markDeployedButton')}
                </button>
              ) : (
                <button onClick={() => toggleDeployStatus(env)}
                  className="w-full mt-1.5 flex items-center justify-center gap-1 px-2 py-1 rounded text-[11px] font-medium transition-colors border border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted/50">
                  {t('taskDetail.deployment.switchToScheduled')}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default TaskDeploymentSection;
