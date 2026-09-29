import { X, Plus, Lock, CornerDownRight, GitBranch } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { TaskDetailState } from './hooks/useTaskDetail';

type Props = { detail: TaskDetailState };

const TaskDependencySection = ({ detail }: Props) => {
  const { t } = useTranslation();
  const {
    task, allTasks, statuses,
    taskDependencies, addTaskDependency, removeTaskDependency,
    depSearchQuery, setDepSearchQuery, depDropdownOpen, setDepDropdownOpen, depDropdownRef,
    setSelectedTask,
  } = detail;

  if (!task) return null;

  const deps = taskDependencies.filter(d => d.taskId === task.id);
  const successors = taskDependencies.filter(d => d.dependsOnTaskId === task.id);
  const hasUnfinishedDeps = deps.some(dep => {
    const depTask = allTasks.find(t => t.id === dep.dependsOnTaskId);
    const depStatus = depTask ? statuses.find(s => s.id === depTask.statusId) : null;
    return depStatus && !depStatus.isDone;
  });

  return (
    <div className="relative" ref={depDropdownRef}>
      <label className="text-[11px] font-medium uppercase tracking-wider flex items-center gap-1 text-muted-foreground">
        <GitBranch size={11} />{t('taskDetail.dependency.predecessors')}
      </label>
      <div className="mt-1.5">
        {deps.length === 0 ? (
          <p className="text-xs text-muted-foreground mb-1.5">{t('taskDetail.dependency.noPredecessors')}</p>
        ) : (
          <div className="space-y-1.5 mb-1.5">
            {deps.map(dep => {
              const depTask = allTasks.find(t => t.id === dep.dependsOnTaskId);
              if (!depTask) return null;
              const depStatus = statuses.find(s => s.id === depTask.statusId);
              const isDone = depStatus?.isDone ?? false;
              return (
                <div key={dep.id} className="flex items-start gap-1.5 group rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <button type="button" onClick={() => setSelectedTask(depTask)}
                      className="text-xs text-primary hover:underline text-left w-full leading-snug"
                      title={`${depTask.taskKey}: ${depTask.title}`}>
                      <span className="font-medium text-muted-foreground mr-1">{depTask.taskKey}</span>
                      <span className={isDone ? 'line-through opacity-60' : ''}>{depTask.title}</span>
                    </button>
                    {depStatus && (
                      <span
                        className="inline-flex items-center mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full"
                        style={{ backgroundColor: `${depStatus.color}22`, color: depStatus.color }}
                      >
                        {isDone && <span className="mr-0.5">✓</span>}{depStatus.name}
                      </span>
                    )}
                  </div>
                  <button type="button" onClick={() => removeTaskDependency(dep.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all flex-shrink-0 mt-0.5">
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        {hasUnfinishedDeps && (
          <div className="flex items-center gap-1.5 text-[10px] text-amber-600 bg-amber-50 dark:bg-amber-900/20 dark:text-amber-400 rounded px-2 py-1 mb-1.5">
            <Lock size={10} /><span>{t('taskDetail.dependency.blocked')}</span>
          </div>
        )}
        <button type="button" onClick={() => { setDepDropdownOpen(!depDropdownOpen); setDepSearchQuery(''); }}
          className="w-full text-xs font-medium rounded px-2 py-1.5 flex items-center justify-between border border-border transition-colors text-foreground bg-muted hover:bg-muted/80">
          <span>{t('taskDetail.dependency.addPredecessor')}</span><Plus size={12} />
        </button>
        {depDropdownOpen && (
          <div className="absolute z-50 mt-1 w-full bg-card border border-border rounded-lg shadow-lg py-1 max-h-60 overflow-y-auto">
            <div className="px-2.5 py-1.5 border-b border-border">
              <input type="text" value={depSearchQuery} onChange={e => setDepSearchQuery(e.target.value)}
                placeholder={t('taskDetail.dependency.searchPlaceholder')} autoFocus
                className="w-full text-xs border border-border rounded px-2 py-1 bg-background text-foreground placeholder:text-muted-foreground/50 outline-none focus:ring-1 focus:ring-primary" />
            </div>
            {(() => {
              const existingDepIds = deps.map(d => d.dependsOnTaskId);
              const q = depSearchQuery.toLowerCase();
              const candidates = allTasks
                .filter(t => t.id !== task.id && !existingDepIds.includes(t.id))
                .filter(t => !q || t.taskKey.toLowerCase().includes(q) || t.title.toLowerCase().includes(q))
                .slice(0, 20);
              if (candidates.length === 0) return (
                <p className="text-xs text-muted-foreground px-2.5 py-2">{q ? t('taskDetail.dependency.noSearchResults', { query: q }) : t('taskDetail.dependency.noAvailableTasks')}</p>
              );
              return candidates.map(cand => {
                const s = statuses.find(st => st.id === cand.statusId);
                const isDone = s?.isDone ?? false;
                return (
                  <button key={cand.id} type="button"
                    onClick={async () => { const ok = await addTaskDependency(task.id, cand.id); if (ok) { setDepDropdownOpen(false); setDepSearchQuery(''); } }}
                    className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-accent transition-colors">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s?.color || '#6B778C' }} />
                    <span className="font-medium text-muted-foreground flex-shrink-0">{cand.taskKey}</span>
                    <span className={`truncate ${isDone ? 'opacity-50' : ''}`}>{cand.title}</span>
                    {isDone && <span className="text-[10px] text-green-600 flex-shrink-0">{t('taskDetail.dependency.doneStatus')}</span>}
                  </button>
                );
              });
            })()}
          </div>
        )}
      </div>
      {/* Successors */}
      {successors.length > 0 && (
        <div className="mt-3">
          <label className="text-[11px] font-medium uppercase tracking-wider flex items-center gap-1 mb-1.5 text-muted-foreground">
            <CornerDownRight size={11} />{t('taskDetail.dependency.successors')}
          </label>
          <div className="space-y-1.5">
            {successors.map(dep => {
              const succTask = allTasks.find(t => t.id === dep.taskId);
              if (!succTask) return null;
              const succStatus = statuses.find(s => s.id === succTask.statusId);
              const isDone = succStatus?.isDone ?? false;
              return (
                <div key={dep.id} className="flex items-start gap-1.5 rounded-md border border-border/60 bg-muted/30 px-2 py-1.5">
                  <div className="flex-1 min-w-0">
                    <button type="button" onClick={() => setSelectedTask(succTask)}
                      className="text-xs text-primary hover:underline text-left w-full leading-snug"
                      title={`${succTask.taskKey}: ${succTask.title}`}>
                      <span className="font-medium text-muted-foreground">{succTask.taskKey}</span>
                      {': '}{succTask.title}
                    </button>
                    <div className="flex items-center gap-1 mt-0.5">
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${isDone ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
                      <span className="text-[10px] text-muted-foreground">{isDone ? t('taskDetail.dependency.doneStatus') : t('taskDetail.dependency.inProgressStatus')}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeTaskDependency(dep.id)}
                    className="p-0.5 text-muted-foreground hover:text-destructive transition-colors"
                    title={t('taskDetail.dependency.removeTitle')}
                  >
                    ×
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default TaskDependencySection;