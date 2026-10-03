import { useTaskQueries } from './useTaskQueries';
import { useTaskCRUD } from './useTaskCRUD';
import { useTaskRelations } from './useTaskRelations';

export function useTaskState(currentMemberId = '') {
  const queries = useTaskQueries();

  const crud = useTaskCRUD({
    allTasks: queries.allTasks,
    statuses: queries.statuses,
    setAllTasks: queries.setAllTasks,
    refreshTasks: queries.refreshTasks,
    appendStatusLog: queries.appendStatusLog,
    webhookConfigRef: queries.webhookConfigRef,
  });

  const relations = useTaskRelations({
    currentMemberId,
    taskDependencies: queries.taskDependencies,
    setTaskDependencies: queries.setTaskDependencies,
    customFieldValues: queries.customFieldValues,
    setCustomFieldValues: queries.setCustomFieldValues,
    setCustomFields: queries.setCustomFields,
    setTaskTemplates: queries.setTaskTemplates,
    refreshCustomFields: queries.refreshCustomFields,
    refreshTaskTemplates: queries.refreshTaskTemplates,
  });

  return {
    ...queries,
    ...crud,
    ...relations,
  };
}
