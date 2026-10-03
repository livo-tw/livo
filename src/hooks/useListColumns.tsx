import { createProjectColorResolver } from '@/lib/projectColors';
/**
 * useListColumns — shared hook for all three list views (ListView, AllListView, MyTasksView).
 *
 * Returns:
 *  - columnConfig   : ColumnConfig (visibleColumns, toggle, reorder, resetToDefault, …)
 *  - renderCell     : (task, key) => ReactNode — unified cell renderer
 *
 * All renderCell logic lives here exactly once; each view just calls it.
 * Custom field columns (cf_*) are automatically included when the view opts in.
 */
import { useMemo } from 'react';
import { AlertTriangle, ExternalLink, ListTree } from 'lucide-react';
import { useTaskContext } from '@/context/TaskContext';
import { useProjectContext } from '@/context/ProjectContext';
import { useMemberContext } from '@/context/MemberContext';
import { useSprintContext } from '@/context/SprintContext';
import { useLicense } from '@/context/LicenseContext';
import { useColumnConfig, type ColumnDef } from '@/hooks/useColumnConfig';
import { FIXED_COLUMNS, OPTIONAL_COLUMNS } from '@/lib/columnDefs';
import type { Priority, Task } from '@/types';
import {
  StatusBadge,
  ProjectBadge,
  PriorityBadge,
  UserBadge,
  priorityConfig,
} from '@/components/ui/badges';

/** Context data needed by renderCell — passed in so the hook stays pure. */
export interface ListCellContext {
  allTasks: Task[];
  statuses: ReturnType<typeof useTaskContext>['statuses'];
  users: ReturnType<typeof useMemberContext>['users'];
  allProjects: ReturnType<typeof useProjectContext>['allProjects'];
  tags: ReturnType<typeof useTaskContext>['tags'];
  sprints: ReturnType<typeof useSprintContext>['sprints'];
  taskDependencies: ReturnType<typeof useTaskContext>['taskDependencies'];
  customFields: ReturnType<typeof useTaskContext>['customFields'];
  customFieldValues: ReturnType<typeof useTaskContext>['customFieldValues'];
}

const today = new Date();
today.setHours(0, 0, 0, 0);

/** Default date formatter: "3月31日" */
const defaultFormatDate = (d?: string): string => {
  if (!d) return '—';
  const dt = new Date(d);
  return `${dt.getMonth() + 1}月${dt.getDate()}日`;
};

/**
 * Build the renderCell function for list views.
 * Exported separately so callers can pass a custom formatDate if needed.
 */
export function buildRenderCell(
  ctx: ListCellContext,
  formatDate: (d?: string) => string = defaultFormatDate,
) {
  const { allTasks, statuses, users, allProjects, tags, sprints, taskDependencies, customFields, customFieldValues } = ctx;

  const getProjectColor = createProjectColorResolver(allProjects);
  return function renderCell(task: Task, key: string): React.ReactNode {
    const status = statuses.find(s => s.id === task.statusId);
    const assignee = users.find(u => u.id === task.assigneeId);
    const reviewer = users.find(u => u.id === task.reviewerId);
    const project = allProjects.find(p => p.id === task.projectId);
    const isDone = status?.isDone;
    const isOverdue = task.dueDate && new Date(task.dueDate) < today && !task.completedAt;

    switch (key) {
      case 'taskKey':
        return (
          <span className="text-primary font-medium text-[13px] truncate">{task.taskKey}</span>
        );

      case 'title':
        return (
          <span className={`truncate text-[13px] ${isDone ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {task.title}
          </span>
        );

      case 'project':
        return project ? <ProjectBadge name={project.name} color={getProjectColor(project)} /> : null;

      case 'status':
        return <StatusBadge name={status?.name} color={status?.color} />;

      case 'priority':
        return <PriorityBadge priority={task.priority as Priority} />;

      case 'createdAt':
        return (
          <span className="text-[13px] text-muted-foreground whitespace-nowrap">
            {formatDate(task.createdAt)}
          </span>
        );

      case 'startedAt':
        return (
          <span className="text-[13px] text-muted-foreground whitespace-nowrap">
            {formatDate(task.startedAt)}
          </span>
        );

      case 'dueDate':
        return (
          <span className={`text-[13px] whitespace-nowrap flex items-center gap-1 ${isOverdue ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
            {isOverdue && <AlertTriangle size={10} />}
            {formatDate(task.dueDate)}
          </span>
        );

      case 'sprint':
        return (
          <span className="text-[13px] text-muted-foreground truncate">
            {sprints.find(s => s.id === task.sprintId)?.name || '—'}
          </span>
        );

      case 'department':
        return (
          <span className="text-[13px] text-muted-foreground">{task.department || '—'}</span>
        );

      case 'assignee':
        return <UserBadge user={assignee} />;

      case 'reviewer':
        return <UserBadge user={reviewer} />;

      case 'tags':
        return task.tagIds && task.tagIds.length > 0 ? (
          <div className="flex flex-wrap gap-0.5">
            {task.tagIds.map((tagId: string) => {
              const tag = tags.find(t => t.id === tagId);
              if (!tag) return null;
              return (
                <span
                  key={tag.id}
                  className="text-[10px] px-1.5 py-0.5 rounded text-white font-semibold"
                  style={{ backgroundColor: tag.color }}
                >
                  {tag.name}
                </span>
              );
            })}
          </div>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        );

      case 'deployments':
        return task.deployments?.length > 0 ? (
          <div className="flex flex-wrap gap-0.5">
            {task.deployments.map((d, i: number) => (
              <span key={i} className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                {d.environment}
                {d.deployDate
                  ? ` ${new Date(d.deployDate).getMonth() + 1}/${new Date(d.deployDate).getDate()}`
                  : ''}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        );

      case 'gitlabUrl':
        return task.gitlabUrl ? (
          <a
            href={task.gitlabUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={e => e.stopPropagation()}
            className="text-primary hover:underline inline-flex items-center gap-0.5 text-[12px]"
          >
            <ExternalLink size={11} />MR
          </a>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        );

      case 'subtasks': {
        const subs = allTasks.filter(t => t.parentTaskId === task.id);
        if (subs.length === 0) return <span className="text-muted-foreground/40">—</span>;
        const doneCount = subs.filter(t => statuses.find(s => s.id === t.statusId)?.isDone).length;
        return (
          <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
            <ListTree size={11} />
            {doneCount}/{subs.length}
          </span>
        );
      }

      case 'dependencies': {
        const deps = taskDependencies.filter(d => d.taskId === task.id);
        if (deps.length === 0) return <span className="text-muted-foreground/40">—</span>;
        const blockedCount = deps.filter(dep => {
          const depTask = allTasks.find(t => t.id === dep.dependsOnTaskId);
          if (!depTask) return false;
          return !statuses.find(s => s.id === depTask.statusId)?.isDone;
        }).length;
        return (
          <span className={`text-[12px] ${blockedCount > 0 ? 'text-amber-600' : 'text-muted-foreground'}`}>
            {blockedCount > 0 ? `⛔ ${deps.length}` : `✓ ${deps.length}`}
          </span>
        );
      }

      default:
        // Custom field columns: key starts with "cf_"
        if (key.startsWith('cf_')) {
          const fieldId = key.slice(3);
          const fieldDef = customFields.find(f => f.id === fieldId);
          const cv = customFieldValues.find(v => v.taskId === task.id && v.fieldId === fieldId);
          if (!fieldDef || !cv) return <span className="text-muted-foreground/40">—</span>;
          if (fieldDef.fieldType === 'boolean') {
            return <span className="text-[12px]">{cv.valueBoolean ? '✓' : '✗'}</span>;
          }
          if (fieldDef.fieldType === 'user') {
            const u = users.find(u => u.id === cv.valueUserId);
            return u ? <UserBadge user={u} /> : <span className="text-muted-foreground/40">—</span>;
          }
          const val =
            cv.valueText ||
            (cv.valueNumber !== undefined ? String(cv.valueNumber) : '') ||
            cv.valueDate ||
            '';
          return val ? (
            <span className="text-[12px] text-foreground truncate">{val}</span>
          ) : (
            <span className="text-muted-foreground/40">—</span>
          );
        }
        return null;
    }
  };
}

// ─────────────────────────────────────────────────────────────
//  useListColumns hook
// ─────────────────────────────────────────────────────────────

export interface UseListColumnsOptions {
  /** Supabase persistence key, e.g. 'listview-columns' */
  storageKey: string;
  /** If true, append custom field columns for visible projects */
  includeCustomFields?: boolean;
  /** If provided, only include custom fields for this project */
  selectedProjectId?: string | null;
  /** Optional date formatter override (defaults to "月/日" format) */
  formatDate?: (d?: string) => string;
}

export function useListColumns(options: UseListColumnsOptions) {
  const {
    storageKey,
    includeCustomFields = false,
    selectedProjectId,
    formatDate,
  } = options;

  const { allTasks, statuses, tags, taskDependencies, customFields, customFieldValues } = useTaskContext();
  const { allProjects } = useProjectContext();
  const { users } = useMemberContext();
  const { sprints } = useSprintContext();

  const { hasFeature } = useLicense();

  // Build the optional columns list, applying license gates + optional custom fields
  const dynamicOptionalColumns = useMemo<ColumnDef[]>(() => {
    const cols = OPTIONAL_COLUMNS.filter(c => {
      if (c.key === 'subtasks') return hasFeature('subtasks');
      if (c.key === 'dependencies') return hasFeature('task-dependencies');
      return true;
    });

    if (includeCustomFields) {
      const visibleProjectIds = selectedProjectId
        ? [selectedProjectId]
        : allProjects.map(p => p.id);
      const visibleCustomFields = customFields.filter(f =>
        visibleProjectIds.includes(f.projectId)
      );
      visibleCustomFields.forEach(f => {
        const colKey = `cf_${f.id}`;
        if (!cols.find(c => c.key === colKey)) {
          cols.push({ key: colKey, label: f.fieldName, width: '110px' });
        }
      });
    }

    return cols;
  }, [hasFeature, includeCustomFields, selectedProjectId, allProjects, customFields]);

  const columnConfig = useColumnConfig(
    storageKey,
    FIXED_COLUMNS,
    dynamicOptionalColumns,
    // Default visible keys are already persisted in DB; useColumnConfig handles fallback
    OPTIONAL_COLUMNS.filter(c => ['project', 'status', 'priority', 'dueDate', 'assignee', 'reviewer'].includes(c.key)).map(c => c.key),
  );

  // Build renderCell — memoized, recreated only when context data changes
  const renderCell = useMemo(
    () => buildRenderCell(
        { allTasks, statuses, users, allProjects, tags, sprints, taskDependencies, customFields, customFieldValues },
        formatDate,
      ),
    [allTasks, statuses, users, allProjects, tags, sprints, taskDependencies, customFields, customFieldValues, formatDate],
  );

  return { columnConfig, renderCell, dynamicOptionalColumns };
}
